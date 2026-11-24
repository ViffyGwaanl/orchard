/**
 * Remote mode: serves Orchard over Streamable HTTP on 127.0.0.1 so that a
 * Cloudflare Tunnel can publish it as an HTTPS address for a claude.ai custom
 * connector. Every MCP request needs an OAuth access token from the built-in
 * authorization server (see oauth.ts); without one the answer is 401.
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import {
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  oauthMetadataResponse,
  requireBearerAuth,
  type AuthMetadataOptions,
} from "@modelcontextprotocol/server";
import { ensureHelperBuilt } from "../helper/build.js";
import { createServer } from "../server.js";
import { VERSION } from "../version.js";
import { remoteDir, type RemoteConfig } from "./config.js";
import { OAuthServer, SCOPE } from "./oauth.js";

const MAX_BODY = 4 * 1024 * 1024;

export interface StartedHttpServer {
  server: HttpServer;
  oauth: OAuthServer;
  port: number;
  close: () => Promise<void>;
}

export interface StartOptions {
  /** Keep oauth state in memory only (tests). */
  ephemeral?: boolean;
  /** Listen on this port instead of the configured one (0 = any free port). */
  port?: number;
  log?: (line: string) => void;
}

/** The web-standard request handler: OAuth endpoints, discovery documents, and the protected MCP endpoint. */
export function createFetchHandler(cfg: RemoteConfig, oauth: OAuthServer, log: (line: string) => void = () => {}) {
  const publicUrl = new URL(cfg.publicUrl);
  const mcpPath = publicUrl.pathname;
  const allowedHosts = [publicUrl.hostname, "localhost", "127.0.0.1"];
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(publicUrl);
  const metaOptions: AuthMetadataOptions = {
    oauthMetadata: oauth.metadata(),
    resourceServerUrl: publicUrl,
    scopesSupported: [SCOPE],
    resourceName: "Orchard",
    dangerouslyAllowInsecureIssuerUrl: publicUrl.protocol === "http:",
  };
  const prm = buildOAuthProtectedResourceMetadata(metaOptions);
  const gate = requireBearerAuth({ verifier: oauth.verifier, resourceMetadataUrl, expectedResource: publicUrl });
  const mcp = createMcpHandler(createServer, { onerror: (e) => log(`mcp error: ${e.message}`) });

  return async function handle(request: Request): Promise<Response> {
    const rejected = hostHeaderValidationResponse(request, allowedHosts);
    if (rejected) return rejected;
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(`Orchard ${VERSION} is running. Add ${publicUrl.href} to Claude as a custom connector.\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname === "/healthz") return new Response("ok\n", { headers: { "content-type": "text/plain" } });

    // RFC 9728 document: the SDK serves the path-aware location; also answer the bare one.
    if (url.pathname === "/.well-known/oauth-protected-resource" && request.method === "GET") {
      return new Response(JSON.stringify(prm), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    }
    const meta = oauthMetadataResponse(request, metaOptions);
    if (meta) return meta;
    // Some clients look for OpenID discovery; point them at the same metadata.
    if (url.pathname === "/.well-known/openid-configuration") {
      return new Response(JSON.stringify(oauth.metadata()), { headers: { "content-type": "application/json" } });
    }

    const o = await oauth.handle(request);
    if (o) return o;

    if (url.pathname === mcpPath) {
      const auth = await gate(request);
      if (auth instanceof Response) return auth;
      return mcp.fetch(request, { authInfo: auth });
    }
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain" } });
  };
}

async function toWebRequest(req: IncomingMessage, port: number, signal: AbortSignal): Promise<Request> {
  const host = req.headers.host ?? `127.0.0.1:${port}`;
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else headers.set(k, v);
  }
  let body: Buffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw Object.assign(new Error("Request body too large"), { status: 413 });
      chunks.push(c as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body, signal });
}

async function sendWebResponse(res: ServerResponse, response: Response) {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((v, k) => {
    if (k === "set-cookie") return;
    headers[k] = v;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on("close", () => {
    reader.cancel().catch(() => {});
  });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(value)) await new Promise<void>((r) => res.once("drain", () => r()));
  }
  res.end();
}

/**
 * Keeps the Mac from idle-sleeping while the server runs. caffeinate exits by
 * itself when this process does (-w). A closed laptop lid still sleeps.
 */
function keepAwake(log: (line: string) => void) {
  if (process.platform !== "darwin" || /^(0|false|no|off)$/i.test(process.env.ORCHARD_KEEP_AWAKE ?? "1")) return;
  try {
    const p = spawn("/usr/bin/caffeinate", ["-i", "-s", "-w", String(process.pid)], { stdio: "ignore", detached: false });
    p.on("error", (e) => log(`caffeinate failed: ${e.message}`));
    p.unref();
    log("keeping the Mac awake while Orchard runs (caffeinate -i -s)");
  } catch (e) {
    log(`caffeinate failed: ${(e as Error).message}`);
  }
}

export async function startHttpServer(cfg: RemoteConfig, opts: StartOptions = {}): Promise<StartedHttpServer> {
  const log = opts.log ?? ((line: string) => console.error(`[${new Date().toISOString()}] ${line}`));
  const oauth = new OAuthServer({
    publicUrl: new URL(cfg.publicUrl),
    passphrase: cfg.passphrase,
    stateDir: opts.ephemeral ? undefined : remoteDir(),
  });
  const handle = createFetchHandler(cfg, oauth, log);
  const listenPort = opts.port ?? cfg.port;

  const server = createHttpServer((req, res) => {
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const started = Date.now();
    toWebRequest(req, listenPort, ac.signal)
      .then((r) => handle(r))
      .then(async (response) => {
        await sendWebResponse(res, response);
        const path = (req.url ?? "/").split("?")[0];
        if (path !== "/healthz") log(`${req.method} ${path} ${response.status} ${Date.now() - started}ms`);
      })
      .catch((e: Error & { status?: number }) => {
        log(`error on ${req.method} ${(req.url ?? "/").split("?")[0]}: ${e.message}`);
        if (!res.headersSent) {
          res.writeHead(e.status ?? 500, { "content-type": "text/plain" });
          res.end(e.status === 413 ? "Request body too large\n" : "Internal error\n");
        } else res.end();
      });
  });
  // Only the tunnel on this Mac may reach the server; never listen on the network.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : listenPort;
  return {
    server,
    oauth,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Entry for `serve-http`: runs until launchd stops it. */
export async function serveHttp(cfg: RemoteConfig) {
  const log = (line: string) => console.error(`[${new Date().toISOString()}] ${line}`);
  const started = await startHttpServer(cfg, { log });
  log(`orchard ${VERSION} serving ${cfg.publicUrl} on http://127.0.0.1:${started.port}`);
  keepAwake(log);
  ensureHelperBuilt().then(
    (p) => log(`orchard helper ready at ${p}`),
    (e: Error) => log(`orchard helper not ready: ${e.message}`),
  );
  const stop = () => {
    log("stopping");
    started.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

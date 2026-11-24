/**
 * A small OAuth 2.1 authorization server for one person, built into Orchard so
 * claude.ai can connect to it as a custom connector.
 *
 * - Clients register themselves (RFC 7591 Dynamic Client Registration) as
 *   public clients, but only with Claude's own redirect addresses
 *   (https://claude.ai/api/mcp/auth_callback, or a loopback /callback for
 *   Claude Code), so a code can never be sent anywhere else.
 * - Signing in means typing the owner passphrase that the install script
 *   generated on the Mac. Wrong guesses are rate limited.
 * - PKCE S256 is required. Codes live 5 minutes and work once.
 * - Access tokens live 1 hour; refresh tokens 30 days and rotate on every use.
 *   Only SHA-256 hashes of codes and tokens are stored.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { checkPassphrase, ensureRemoteDir, randomToken, sha256, STATE_FILE, writePrivate, type PassphraseHash } from "./config.js";

export const SCOPE = "orchard";
export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_CLIENTS = 50;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_REGISTRATIONS_PER_HOUR = 20;

/** Redirect addresses Claude's hosted apps use. */
export const HOSTED_REDIRECTS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

interface StoredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: number;
  last_used_at: number;
}

interface StoredToken {
  clientId: string;
  scope: string;
  resource: string;
  exp: number; // seconds since epoch
}

interface State {
  clients: Record<string, StoredClient>;
  access: Record<string, StoredToken>; // key: sha256(token)
  refresh: Record<string, StoredToken>; // key: sha256(token)
}

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope: string;
  resource: string;
  expires: number;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  expires: number;
}

export interface OAuthServerOptions {
  /** Public MCP endpoint, e.g. https://orchard.example.com/mcp */
  publicUrl: URL;
  passphrase: PassphraseHash;
  /** Where oauth-state.json lives; omit to keep state in memory only (tests). */
  stateDir?: string;
  now?: () => number;
}

/** True for http://localhost:<port>/callback and http://127.0.0.1:<port>/callback. */
export function isLoopbackRedirect(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.pathname === "/callback" && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}

export function isAllowedRedirect(raw: string): boolean {
  return HOSTED_REDIRECTS.includes(raw) || isLoopbackRedirect(raw);
}

/** Exact match, except that a loopback redirect matches on any port (RFC 8252 7.3). */
export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  if (!isLoopbackRedirect(requested)) return false;
  const want = new URL(requested);
  return registered.some((r) => {
    if (!isLoopbackRedirect(r)) return false;
    const have = new URL(r);
    return have.hostname === want.hostname && have.pathname === want.pathname;
  });
}

export function pkceS256(verifier: string): string {
  return sha256(verifier);
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...extra },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function page(title: string, inner: string, status = 200): Response {
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--fg:#1d1d1f;--muted:#6e6e73;--accent:#2f7d4f;--warn:#b54708;--line:#d8d6d0}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1f1f1f;--fg:#f2f2f2;--muted:#a1a1a6;--accent:#5fbf86;--warn:#f0a35e;--line:#3a3a3a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:14px;max-width:440px;width:100%;padding:28px}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:14px}.warn{color:var(--warn);font-size:14px}.err{color:var(--warn);font-weight:600}
code{font-family:ui-monospace,Menlo,monospace;font-size:14px;word-break:break-all}
input[type=password]{width:100%;font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;margin:4px 0 16px}
.row{display:flex;gap:10px}button{flex:1;font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
</style></head><body><main>${inner}</main></body></html>`;
  return new Response(html, { status, headers: HTML_HEADERS });
}

export class OAuthServer {
  readonly issuer: string;
  readonly resource: string;
  private readonly now: () => number;
  private state: State = { clients: {}, access: {}, refresh: {} };
  private pending = new Map<string, PendingAuthorization>();
  private codes = new Map<string, IssuedCode>();
  private failures: number[] = [];
  private registrations: number[] = [];

  constructor(private readonly opts: OAuthServerOptions) {
    this.issuer = opts.publicUrl.origin;
    this.resource = opts.publicUrl.href;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  // ---------- persistence ----------

  private statePath(): string | null {
    return this.opts.stateDir ? join(this.opts.stateDir, STATE_FILE) : null;
  }

  private load() {
    const p = this.statePath();
    if (!p || !existsSync(p)) return;
    try {
      const s = JSON.parse(readFileSync(p, "utf8")) as State;
      this.state = { clients: s.clients ?? {}, access: s.access ?? {}, refresh: s.refresh ?? {} };
    } catch {
      // A damaged state file only means everyone signs in again.
      this.state = { clients: {}, access: {}, refresh: {} };
    }
  }

  private save() {
    const nowS = Math.floor(this.now() / 1000);
    for (const bag of [this.state.access, this.state.refresh]) {
      for (const [k, t] of Object.entries(bag)) if (t.exp <= nowS) delete bag[k];
    }
    const p = this.statePath();
    if (!p) return;
    ensureRemoteDir();
    writePrivate(p, JSON.stringify(this.state));
  }

  /** Signs out every client, for a passphrase reset. */
  revokeAll() {
    this.state = { clients: {}, access: {}, refresh: {} };
    this.pending.clear();
    this.codes.clear();
    this.save();
  }

  // ---------- metadata ----------

  metadata(): OAuthMetadata {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      revocation_endpoint: `${this.issuer}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
      service_documentation: "https://github.com/ViffyGwaanl/orchard",
    } as OAuthMetadata;
  }

  // ---------- token verification for the MCP endpoint ----------

  readonly verifier: OAuthTokenVerifier = {
    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
      const t = this.state.access[sha256(token)];
      const nowS = Math.floor(this.now() / 1000);
      if (!t || t.exp <= nowS) throw new OAuthError(OAuthErrorCode.InvalidToken, "Unknown or expired access token");
      return { token, clientId: t.clientId, scopes: t.scope.split(" ").filter(Boolean), expiresAt: t.exp, resource: new URL(t.resource) };
    },
  };

  // ---------- routing ----------

  /** Answers /register, /authorize, /token and /revoke; undefined for anything else. */
  async handle(req: Request): Promise<Response | undefined> {
    const path = new URL(req.url).pathname;
    try {
      if (path === "/register") return req.method === "POST" ? await this.register(req) : oauthError("invalid_request", "Use POST", 405);
      if (path === "/authorize") {
        if (req.method === "GET") return this.authorizeGet(req);
        if (req.method === "POST") return await this.authorizePost(req);
        return oauthError("invalid_request", "Use GET or POST", 405);
      }
      if (path === "/token") return req.method === "POST" ? await this.token(req) : oauthError("invalid_request", "Use POST", 405);
      if (path === "/revoke") return req.method === "POST" ? await this.revoke(req) : oauthError("invalid_request", "Use POST", 405);
    } catch (e) {
      return oauthError("server_error", (e as Error).message, 500);
    }
    return undefined;
  }

  // ---------- registration ----------

  private async register(req: Request): Promise<Response> {
    // Registration is open by design (claude.ai registers itself), so cap how fast
    // new clients can appear; otherwise a stranger could push out the real ones.
    const now0 = this.now();
    this.registrations = this.registrations.filter((t) => now0 - t < 60 * 60 * 1000);
    if (this.registrations.length >= MAX_REGISTRATIONS_PER_HOUR) {
      return oauthError("temporarily_unavailable", "Too many client registrations, try again later", 429);
    }
    this.registrations.push(now0);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return oauthError("invalid_client_metadata", "Body must be JSON");
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every((u) => typeof u === "string")) {
      return oauthError("invalid_redirect_uri", "redirect_uris must be a non-empty list");
    }
    const bad = (uris as string[]).filter((u) => !isAllowedRedirect(u));
    if (bad.length) {
      return oauthError("invalid_redirect_uri", `This Orchard server only accepts Claude's own redirect addresses. Not allowed: ${bad.join(", ")}`);
    }
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 80) : undefined;
    const now = this.now();
    const client: StoredClient = {
      client_id: randomToken("orc_client_"),
      client_name: name,
      redirect_uris: uris as string[],
      created_at: now,
      last_used_at: now,
    };
    const ids = Object.values(this.state.clients).sort((a, b) => a.last_used_at - b.last_used_at);
    while (ids.length >= MAX_CLIENTS) {
      const old = ids.shift()!;
      delete this.state.clients[old.client_id];
    }
    this.state.clients[client.client_id] = client;
    this.save();
    return json(
      {
        client_id: client.client_id,
        client_id_issued_at: Math.floor(now / 1000),
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      },
      201,
    );
  }

  // ---------- authorization ----------

  private gc() {
    const now = this.now();
    for (const [k, v] of this.pending) if (v.expires <= now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expires <= now) this.codes.delete(k);
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
  }

  private lockedUntil(): number | null {
    this.gc();
    if (this.failures.length < MAX_FAILURES) return null;
    return this.failures[0] + FAILURE_WINDOW_MS;
  }

  private authorizeGet(req: Request): Response {
    this.gc();
    const q = new URL(req.url).searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    const client = this.state.clients[clientId];
    // Without a known client and a matching redirect we must not redirect anywhere.
    if (!client) return page("无法连接", `<h1>无法连接</h1><p>这个应用还没有在 Orchard 登记，请回到 Claude 重新添加连接器。</p>`, 400);
    if (!redirectUri || !redirectMatches(client.redirect_uris, redirectUri)) {
      return page("无法连接", `<h1>无法连接</h1><p>回调地址和登记的不一致，Orchard 已拒绝这次请求。</p>`, 400);
    }
    const back = (error: string, description: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      const st = q.get("state");
      if (st) u.searchParams.set("state", st);
      u.searchParams.set("iss", this.issuer);
      return Response.redirect(u.href, 302);
    };
    if (q.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
    const challenge = q.get("code_challenge") ?? "";
    if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
      return back("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    const resource = q.get("resource") ?? this.resource;
    if (!sameResource(resource, this.resource)) return back("invalid_target", `This server only issues tokens for ${this.resource}`);
    const scope = (q.get("scope") ?? SCOPE).split(/\s+/).filter((s) => s === SCOPE).join(" ") || SCOPE;

    const id = randomToken("");
    this.pending.set(id, {
      clientId,
      redirectUri,
      codeChallenge: challenge,
      state: q.get("state") ?? undefined,
      scope,
      resource: this.resource,
      expires: this.now() + PENDING_TTL_MS,
    });
    return this.consentPage(id, client, redirectUri);
  }

  private consentPage(id: string, client: StoredClient, redirectUri: string, error?: string, status = 200): Response {
    const host = new URL(redirectUri).host;
    const loopback = isLoopbackRedirect(redirectUri);
    const locked = this.lockedUntil();
    const who = client.client_name ? esc(client.client_name) : "Claude";
    const err = error ? `<p class="err">${esc(error)}</p>` : "";
    const warn = loopback
      ? `<p class="warn">这次登录会把授权交给本机的 <code>${esc(host)}</code>，通常来自 Claude Code。如果你没有在这台电脑上发起连接，请点拒绝。</p>`
      : "";
    const form = locked
      ? `<p class="err">口令输错次数太多，请在 ${new Date(locked).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 之后再试。</p>`
      : `<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="req" value="${esc(id)}">
<label for="pw">Orchard 访问口令</label>
<input id="pw" name="passphrase" type="password" autofocus required maxlength="200">
<div class="row"><button type="submit" name="action" value="deny">拒绝</button><button class="primary" type="submit" name="action" value="allow">允许</button></div>
</form>`;
    return page(
      "允许 Claude 访问 Orchard",
      `<h1>允许 ${who} 访问你的 Mac</h1>
<p>${who} 想通过 Orchard 读取和修改这台 Mac 上的提醒事项、日历、备忘录、邮件、信息和通讯录。</p>
<p class="muted">授权完成后会跳转到 <code>${esc(host)}</code></p>
${warn}${err}${form}
<p class="muted">只有在你自己刚刚在 Claude 里点了连接时才输入口令。如果这个页面是从别人发来的链接打开的，请点拒绝。</p>
<p class="muted">口令在安装时生成，保存在这台 Mac 的钥匙串里，名称是 Orchard remote passphrase。</p>`,
      status,
    );
  }

  private async authorizePost(req: Request): Promise<Response> {
    this.gc();
    const form = new URLSearchParams(await req.text());
    const id = form.get("req") ?? "";
    const p = this.pending.get(id);
    if (!p) return page("请求已过期", `<h1>请求已过期</h1><p>这个授权页面已经失效，请回到 Claude 重新连接。</p>`, 400);
    const client = this.state.clients[p.clientId];
    if (!client) {
      this.pending.delete(id);
      return page("无法连接", `<h1>无法连接</h1><p>这个应用的登记已被清除，请回到 Claude 重新连接。</p>`, 400);
    }
    const redirect = (params: Record<string, string>) => {
      this.pending.delete(id);
      const u = new URL(p.redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (p.state) u.searchParams.set("state", p.state);
      u.searchParams.set("iss", this.issuer);
      return Response.redirect(u.href, 302);
    };
    if (form.get("action") === "deny") return redirect({ error: "access_denied", error_description: "The owner declined." });
    if (this.lockedUntil()) return this.consentPage(id, client, p.redirectUri, undefined, 429);
    if (!checkPassphrase(form.get("passphrase") ?? "", this.opts.passphrase)) {
      this.failures.push(this.now());
      const left = MAX_FAILURES - this.failures.length;
      return this.consentPage(id, client, p.redirectUri, left > 0 ? `口令不对，还可以再试 ${left} 次。` : undefined, 401);
    }
    this.failures = [];
    const code = randomToken("orc_code_");
    this.codes.set(sha256(code), {
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      scope: p.scope,
      resource: p.resource,
      expires: this.now() + CODE_TTL_MS,
    });
    client.last_used_at = this.now();
    this.save();
    return redirect({ code });
  }

  // ---------- token ----------

  private async readParams(req: Request): Promise<URLSearchParams> {
    const type = req.headers.get("content-type") ?? "";
    const text = await req.text();
    if (type.includes("application/json")) {
      const obj = JSON.parse(text || "{}") as Record<string, unknown>;
      const out = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) if (typeof v === "string") out.set(k, v);
      return out;
    }
    return new URLSearchParams(text);
  }

  private clientIdFrom(req: Request, params: URLSearchParams): string {
    const basic = req.headers.get("authorization");
    if (basic?.startsWith("Basic ")) {
      try {
        const [id] = Buffer.from(basic.slice(6), "base64").toString("utf8").split(":");
        return decodeURIComponent(id ?? "");
      } catch {
        return "";
      }
    }
    return params.get("client_id") ?? "";
  }

  private issue(clientId: string, scope: string, resource: string) {
    const nowS = Math.floor(this.now() / 1000);
    const access = randomToken("orc_at_");
    const refresh = randomToken("orc_rt_");
    this.state.access[sha256(access)] = { clientId, scope, resource, exp: nowS + ACCESS_TTL_S };
    this.state.refresh[sha256(refresh)] = { clientId, scope, resource, exp: nowS + REFRESH_TTL_S };
    const c = this.state.clients[clientId];
    if (c) c.last_used_at = this.now();
    this.save();
    return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope });
  }

  private async token(req: Request): Promise<Response> {
    this.gc();
    let params: URLSearchParams;
    try {
      params = await this.readParams(req);
    } catch {
      return oauthError("invalid_request", "Could not read the request body");
    }
    const clientId = this.clientIdFrom(req, params);
    if (!clientId || !this.state.clients[clientId]) return oauthError("invalid_client", "Unknown client", 401);
    const resource = params.get("resource");
    if (resource && !sameResource(resource, this.resource)) return oauthError("invalid_target", `This server only issues tokens for ${this.resource}`);

    const grant = params.get("grant_type");
    if (grant === "authorization_code") {
      const code = params.get("code") ?? "";
      const key = sha256(code);
      const c = this.codes.get(key);
      this.codes.delete(key); // single use, whatever happens next
      if (!c || c.expires <= this.now()) return oauthError("invalid_grant", "The code is unknown, used or expired");
      if (c.clientId !== clientId) return oauthError("invalid_grant", "The code was issued to another client");
      if ((params.get("redirect_uri") ?? c.redirectUri) !== c.redirectUri) return oauthError("invalid_grant", "redirect_uri does not match");
      const verifier = params.get("code_verifier") ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || pkceS256(verifier) !== c.codeChallenge) {
        return oauthError("invalid_grant", "PKCE verification failed");
      }
      return this.issue(clientId, c.scope, c.resource);
    }
    if (grant === "refresh_token") {
      const key = sha256(params.get("refresh_token") ?? "");
      const t = this.state.refresh[key];
      if (!t || t.exp <= Math.floor(this.now() / 1000) || t.clientId !== clientId) return oauthError("invalid_grant", "The refresh token is unknown, used or expired");
      delete this.state.refresh[key]; // rotate
      return this.issue(clientId, t.scope, t.resource);
    }
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
  }

  private async revoke(req: Request): Promise<Response> {
    let params: URLSearchParams;
    try {
      params = await this.readParams(req);
    } catch {
      return oauthError("invalid_request", "Could not read the request body");
    }
    const key = sha256(params.get("token") ?? "");
    delete this.state.access[key];
    delete this.state.refresh[key];
    this.save();
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  }
}

function sameResource(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/#.*$/, "").replace(/\/$/, "");
  return strip(a) === strip(b);
}

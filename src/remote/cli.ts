/**
 * Command-line entry points for remote mode.
 *
 *   node dist/index.js remote-init --public-url https://orchard.example.com/mcp [--port 8787]
 *   node dist/index.js remote-reset          new passphrase, signs out every client
 *   node dist/index.js remote-status
 *   node dist/index.js serve-http            what launchd runs
 *
 * Messages go to stderr. When a new passphrase is created it is the only thing
 * printed to stdout, so the install script can put it in the Keychain.
 */
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_PORT,
  generatePassphrase,
  hashPassphrase,
  loadConfig,
  remoteDir,
  saveConfig,
  STATE_FILE,
  validatePublicUrl,
  type RemoteConfig,
} from "./config.js";

export const REMOTE_COMMANDS = new Set(["serve-http", "remote-init", "remote-reset", "remote-status"]);

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}

function parsePort(raw: string | undefined, def: number): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`--port must be a number between 1024 and 65535 (got ${raw}).`);
  return n;
}

/** Returns an exit code, or undefined to keep running (serve-http). */
export async function runRemoteCommand(command: string, args: string[]): Promise<number | undefined> {
  const cfgPath = join(remoteDir(), CONFIG_FILE);

  if (command === "serve-http") {
    const { serveHttp } = await import("./http.js");
    await serveHttp(loadConfig());
    return undefined;
  }

  if (command === "remote-init") {
    const raw = arg(args, "--public-url");
    if (!raw) throw new Error("Missing --public-url, e.g. --public-url https://orchard.example.com/mcp");
    const publicUrl = validatePublicUrl(raw).href;
    let existing: RemoteConfig | null = null;
    if (existsSync(cfgPath)) existing = JSON.parse(readFileSync(cfgPath, "utf8")) as RemoteConfig;
    const port = parsePort(arg(args, "--port"), existing?.port ?? DEFAULT_PORT);
    if (existing?.passphrase?.hash && !args.includes("--new-passphrase")) {
      saveConfig({ ...existing, publicUrl, port });
      console.error(`Updated ${cfgPath}: ${publicUrl}, port ${port}. Kept the existing passphrase.`);
      return 0;
    }
    const passphrase = generatePassphrase();
    saveConfig({ publicUrl, port, passphrase: hashPassphrase(passphrase), createdAt: new Date().toISOString() });
    console.error(`Wrote ${cfgPath}: ${publicUrl}, port ${port}. A new passphrase was created.`);
    process.stdout.write(`${passphrase}\n`);
    return 0;
  }

  if (command === "remote-reset") {
    const cfg = loadConfig();
    const passphrase = generatePassphrase();
    saveConfig({ ...cfg, passphrase: hashPassphrase(passphrase) });
    const { OAuthServer } = await import("./oauth.js");
    new OAuthServer({ publicUrl: new URL(cfg.publicUrl), passphrase: cfg.passphrase, stateDir: remoteDir() }).revokeAll();
    console.error("New passphrase created and every connected client signed out. Restart the server so it uses the new passphrase.");
    process.stdout.write(`${passphrase}\n`);
    return 0;
  }

  if (command === "remote-status") {
    const cfg = loadConfig();
    let clients = 0, tokens = 0;
    const statePath = join(remoteDir(), STATE_FILE);
    if (existsSync(statePath)) {
      try {
        const s = JSON.parse(readFileSync(statePath, "utf8")) as { clients?: object; refresh?: object };
        clients = Object.keys(s.clients ?? {}).length;
        tokens = Object.keys(s.refresh ?? {}).length;
      } catch {
        /* ignore */
      }
    }
    let health = "not running";
    try {
      const r = await fetch(`http://127.0.0.1:${cfg.port}/healthz`, { signal: AbortSignal.timeout(2000) });
      health = r.ok ? "running" : `answered ${r.status}`;
    } catch {
      /* not running */
    }
    let publicHealth = "unreachable";
    try {
      const r = await fetch(new URL("/healthz", cfg.publicUrl), { signal: AbortSignal.timeout(8000) });
      publicHealth = r.ok ? "reachable" : `answered ${r.status}`;
    } catch (err) {
      // Name the cause (DNS, timeout, TLS) so a failed check can be diagnosed.
      const e = err as { name?: string; cause?: { code?: string; message?: string } };
      const reason = e.name === "TimeoutError" ? "timed out" : (e.cause?.code ?? e.cause?.message);
      if (reason) publicHealth = `unreachable: ${reason}`;
    }
    console.log(`Public URL:   ${cfg.publicUrl} (${publicHealth})`);
    if (publicHealth !== "reachable") {
      const address = await lookup(new URL(cfg.publicUrl).hostname).then((a) => a.address, () => "");
      // 198.18.0.0/15 is where Clash, Surge and similar proxies hand out fake-ip answers.
      if (/^198\.1[89]\./.test(address)) {
        console.log(
          `              ${address} is a proxy fake-ip, so this check went through your proxy app.\n` +
            "              claude.ai may still reach Orchard; try adding the connector.",
        );
      }
    }
    console.log(`Local server: http://127.0.0.1:${cfg.port} (${health})`);
    console.log(`Signed-in clients: ${clients}, active sessions: ${tokens}`);
    return 0;
  }

  throw new Error(`Unknown command ${command}`);
}

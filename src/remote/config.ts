/**
 * Settings and secrets for remote mode, kept in
 * ~/Library/Application Support/Orchard/remote with owner-only permissions.
 *
 * Nothing secret is stored in clear text: the owner passphrase is kept as a
 * scrypt hash, and OAuth codes and tokens are kept as SHA-256 hashes.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function orchardHome(): string {
  return process.env.ORCHARD_HOME ?? join(homedir(), "Library", "Application Support", "Orchard");
}

export function remoteDir(): string {
  return join(orchardHome(), "remote");
}

export const CONFIG_FILE = "config.json";
export const STATE_FILE = "oauth-state.json";

export interface PassphraseHash {
  algo: "scrypt";
  salt: string; // base64url
  hash: string; // base64url
  N: number;
  r: number;
  p: number;
}

export interface RemoteConfig {
  /** Public HTTPS address of the MCP endpoint, exactly as entered in claude.ai, e.g. https://orchard.example.com/mcp */
  publicUrl: string;
  /** Local port the HTTP server listens on (127.0.0.1 only). */
  port: number;
  passphrase: PassphraseHash;
  createdAt: string;
}

export const DEFAULT_PORT = 8787;

export function ensureRemoteDir(): string {
  const dir = remoteDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  return dir;
}

/** Writes a file atomically with owner-only permissions. */
export function writePrivate(path: string, data: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function loadConfig(): RemoteConfig {
  const path = join(remoteDir(), CONFIG_FILE);
  if (!existsSync(path)) {
    throw new Error(`Remote mode is not set up yet (${path} is missing). Run: node dist/index.js remote-init --public-url https://your.host/mcp`);
  }
  const cfg = JSON.parse(readFileSync(path, "utf8")) as RemoteConfig;
  validatePublicUrl(cfg.publicUrl);
  if (!cfg.passphrase?.hash) throw new Error("The remote config has no passphrase. Run remote-reset to create one.");
  return cfg;
}

export function saveConfig(cfg: RemoteConfig) {
  ensureRemoteDir();
  writePrivate(join(remoteDir(), CONFIG_FILE), `${JSON.stringify(cfg, null, 2)}\n`);
}

/**
 * The public URL must be HTTPS with a path (normally /mcp), because claude.ai
 * only talks to HTTPS endpoints and the OAuth `resource` must match it exactly.
 * Plain http is allowed for localhost so the self-tests can run.
 */
export function validatePublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL. Use something like https://orchard.example.com/mcp`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error(`The public URL must start with https:// (got ${raw}).`);
  if (u.search || u.hash) throw new Error("The public URL must not contain ? or #.");
  if (u.pathname === "/" || u.pathname === "") throw new Error("The public URL needs a path, normally /mcp, e.g. https://orchard.example.com/mcp");
  if (u.pathname.endsWith("/")) throw new Error("The public URL must not end with a slash.");
  return u;
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i

/** 5 groups of 5 characters, about 123 bits of randomness, easy to type. */
export function generatePassphrase(): string {
  const groups: string[] = [];
  for (let g = 0; g < 5; g++) {
    let s = "";
    while (s.length < 5) {
      const b = randomBytes(1)[0];
      if (b < 248) s += ALPHABET[b % ALPHABET.length]; // 248 = 8 * 31, no modulo bias
    }
    groups.push(s);
  }
  return groups.join("-");
}

function normalizePassphrase(p: string): string {
  return p.trim().toLowerCase().replace(/\s+/g, "");
}

export function hashPassphrase(passphrase: string): PassphraseHash {
  const salt = randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = scryptSync(normalizePassphrase(passphrase), salt, 32, { N, r, p });
  return { algo: "scrypt", salt: salt.toString("base64url"), hash: hash.toString("base64url"), N, r, p };
}

export function checkPassphrase(passphrase: string, stored: PassphraseHash): boolean {
  if (typeof passphrase !== "string" || passphrase.length === 0 || passphrase.length > 200) return false;
  const expected = Buffer.from(stored.hash, "base64url");
  const got = scryptSync(normalizePassphrase(passphrase), Buffer.from(stored.salt, "base64url"), expected.length, {
    N: stored.N,
    r: stored.r,
    p: stored.p,
  });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("base64url");
}

export function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

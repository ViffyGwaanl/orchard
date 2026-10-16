/**
 * Compiles the native helper from the Swift source shipped with the extension.
 *
 * Building on the person's own Mac means the binary is never quarantined, needs
 * no notarization, and always matches their macOS SDK. The result lives in
 * ~/Library/Application Support/Orchard so privacy grants survive extension
 * updates as long as the Swift source does not change.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_RECIPE = "v1"; // bump to force a rebuild when flags change

export const ORCHARD_HOME = process.env.ORCHARD_HOME ?? join(homedir(), "Library", "Application Support", "Orchard");
export const HELPER_PATH = join(ORCHARD_HOME, "bin", "orchard-helper");
const HASH_PATH = join(ORCHARD_HOME, "bin", ".source-hash");
export const BUILD_LOG = join(ORCHARD_HOME, "build.log");

function packageRoot(): string {
  // dist/index.js -> package root; src/helper/build.ts -> package root when run from source.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "swift", "OrchardHelper.swift"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Could not find the bundled Swift source (swift/OrchardHelper.swift).");
}

export function sourcePaths(): { swift: string; plist: string } {
  const root = packageRoot();
  return { swift: join(root, "swift", "OrchardHelper.swift"), plist: join(root, "swift", "Info.plist") };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      let code = 0;
      if (err) {
        const c = (err as { code?: unknown }).code;
        code = typeof c === "number" ? c : c === "ENOENT" ? 127 : 1;
      }
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err ? err.message : "")) });
    });
  });
}

export class BuildError extends Error {
  constructor(
    readonly code: "NOT_MACOS" | "SWIFT_MISSING" | "COMPILE_FAILED" | "SIGN_FAILED",
    message: string,
    readonly details = "",
  ) {
    super(message);
  }
}

async function sourceHash(): Promise<string> {
  const { swift, plist } = sourcePaths();
  const h = createHash("sha256");
  h.update(BUILD_RECIPE);
  h.update(await readFile(swift));
  h.update(await readFile(plist));
  h.update(process.arch);
  return h.digest("hex").slice(0, 24);
}

export async function helperIsCurrent(): Promise<boolean> {
  if (!existsSync(HELPER_PATH)) return false;
  try {
    return (await readFile(HASH_PATH, "utf8")).trim() === (await sourceHash());
  } catch {
    return false;
  }
}

let inflight: Promise<string> | null = null;
export let lastBuild: { ok: boolean; at: string; message: string; details?: string } | null = null;

export function ensureHelperBuilt(): Promise<string> {
  if (process.env.ORCHARD_HELPER) return Promise.resolve(process.env.ORCHARD_HELPER);
  if (!inflight) {
    inflight = buildIfNeeded().catch((e) => {
      inflight = null; // allow a retry on the next call
      throw e;
    });
  }
  return inflight;
}

async function log(line: string) {
  try {
    await mkdir(ORCHARD_HOME, { recursive: true });
    await appendFile(BUILD_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging is best effort */
  }
}

async function buildIfNeeded(): Promise<string> {
  if (process.platform !== "darwin") throw new BuildError("NOT_MACOS", "Orchard only runs on macOS.");
  if (await helperIsCurrent()) return HELPER_PATH;

  const which = await run("/usr/bin/xcrun", ["--find", "swiftc"], 60_000);
  if (which.code !== 0) {
    const msg =
      "The Swift compiler is not installed, so Orchard cannot build its native helper. " +
      "Install Apple's Command Line Tools once by running `xcode-select --install` in Terminal (about 5 minutes), then try again.";
    lastBuild = { ok: false, at: new Date().toISOString(), message: msg, details: which.stderr };
    await log(`swiftc missing: ${which.stderr}`);
    throw new BuildError("SWIFT_MISSING", msg, which.stderr);
  }

  const { swift, plist } = sourcePaths();
  const binDir = dirname(HELPER_PATH);
  await mkdir(binDir, { recursive: true });
  const tmp = join(binDir, `orchard-helper.build-${process.pid}`);
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  const started = Date.now();
  await log(`building helper (${arch}) from ${swift}`);
  const compile = await run(
    "/usr/bin/xcrun",
    [
      "swiftc", "-O", "-swift-version", "5", "-target", `${arch}-apple-macos13.0`,
      swift, "-o", tmp,
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist,
    ],
    600_000,
  );
  if (compile.code !== 0) {
    await rm(tmp, { force: true });
    const details = (compile.stderr || compile.stdout).split("\n").filter((l) => /error:/.test(l)).slice(0, 30).join("\n") || compile.stderr.slice(0, 4000);
    lastBuild = { ok: false, at: new Date().toISOString(), message: "The native helper failed to compile.", details };
    await log(`compile failed:\n${compile.stderr}`);
    if (/could not build module 'Foundation'|SDK is not supported by the compiler|module compiled with Swift/i.test(compile.stderr)) {
      throw new BuildError(
        "COMPILE_FAILED",
        "The installed Swift compiler is older than this macOS version's SDK. Update Apple's Command Line Tools (System Settings > General > Software Update, or run `softwareupdate --list` then install the newest Command Line Tools), or install the latest Xcode, then call apple_status again.",
        details,
      );
    }
    throw new BuildError("COMPILE_FAILED", "Orchard's native helper failed to compile on this Mac.", details);
  }
  const sign = await run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "app.orchard.helper", tmp], 60_000);
  if (sign.code !== 0) {
    await rm(tmp, { force: true });
    lastBuild = { ok: false, at: new Date().toISOString(), message: "Signing the helper failed.", details: sign.stderr };
    await log(`codesign failed: ${sign.stderr}`);
    throw new BuildError("SIGN_FAILED", "Could not sign Orchard's native helper.", sign.stderr);
  }
  await rename(tmp, HELPER_PATH);
  await writeFile(HASH_PATH, await sourceHash());
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  lastBuild = { ok: true, at: new Date().toISOString(), message: `Built in ${secs}s` };
  await log(`built in ${secs}s`);
  return HELPER_PATH;
}

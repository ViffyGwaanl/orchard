/**
 * Long-lived connection to the native helper. One process serves every call,
 * so EventKit, Contacts and the SQLite handles stay warm between tool calls.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { BuildError, ensureHelperBuilt } from "./build.js";

export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details = "",
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface Transport {
  call<T = unknown>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
}

class ProcessHelper implements Transport {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail: string[] = [];

  private async start(): Promise<ChildProcessWithoutNullStreams> {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;
    let bin: string;
    try {
      bin = await ensureHelperBuilt();
    } catch (e) {
      if (e instanceof BuildError) throw new HelperError(e.code, e.message, e.details);
      throw e;
    }
    const proc = spawn(bin, ["serve"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    this.proc = proc;
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
    proc.stderr.on("data", (d: Buffer) => {
      this.stderrTail.push(d.toString());
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    proc.on("exit", (code, signal) => {
      if (this.proc === proc) this.proc = null;
      const why = `Orchard's helper stopped (${signal ?? `exit ${code}`}). ${this.stderrTail.join("").slice(-800)}`.trim();
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new HelperError("HELPER_CRASHED", `${why} Try the request again; the helper restarts automatically.`));
        this.pending.delete(id);
      }
    });
    proc.on("error", (err) => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new HelperError("HELPER_START_FAILED", `Could not start Orchard's helper: ${err.message}`));
        this.pending.delete(id);
      }
    });
    return proc;
  }

  private onLine(line: string) {
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new HelperError(msg.error?.code ?? "FAILED", msg.error?.message ?? "The helper reported an error."));
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
    const proc = await this.start();
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? 45_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError("TIMEOUT", `${method} did not finish within ${Math.round(timeoutMs / 1000)} seconds. If macOS is showing a permission dialog, answer it and try again.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  stop() {
    this.proc?.kill();
  }
}

let transport: Transport = new ProcessHelper();

/** Tests swap in a fake transport. */
export function setTransport(t: Transport) {
  transport = t;
}

export function helper(): Transport {
  return transport;
}

export function call<T = unknown>(method: string, params: Record<string, unknown> = {}, opts?: { timeoutMs?: number }): Promise<T> {
  return transport.call<T>(method, params, opts);
}

/** Runs a JXA (default) or AppleScript program through the helper's privacy identity. */
export async function osa<T = unknown>(
  app: string,
  script: string,
  args: unknown,
  opts: { lang?: "JavaScript" | "AppleScript"; timeoutS?: number; raw?: boolean; argv?: string[] } = {},
): Promise<T> {
  const timeoutS = opts.timeoutS ?? 60;
  const out = await call<string>(
    "osa.run",
    { app, script, lang: opts.lang ?? "JavaScript", args: opts.argv ?? [JSON.stringify(args ?? {})], timeout_s: timeoutS },
    { timeoutMs: (timeoutS + 10) * 1000 },
  );
  if (opts.raw) return out as T;
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new HelperError("SCRIPT_ERROR", `${app} returned something unexpected: ${out.slice(0, 300)}`);
  }
}

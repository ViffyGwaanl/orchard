import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
const files = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
await build({ entryPoints: files, bundle: true, platform: "node", format: "esm", target: "node20", outdir: ".test-build", outExtension: { ".js": ".mjs" }, packages: "external", logLevel: "warning" });
const r = spawnSync(process.execPath, ["--test", ...files.map((f) => f.replace(/^test\//, ".test-build/").replace(/\.ts$/, ".mjs"))], { stdio: "inherit" });
process.exit(r.status ?? 1);

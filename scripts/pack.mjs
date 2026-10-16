/**
 * Builds the Claude Desktop extension (.mcpb): bundles the server, gathers the
 * Swift source the helper is compiled from, writes manifest.json with the live
 * tool list, then validates and packs it.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
execFileSync("node", ["scripts/bundle.mjs"], { stdio: "inherit" });

const client = new Client({ name: "orchard-pack", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...getDefaultEnvironment(), ORCHARD_HELPER: "/nonexistent" } }));
const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();
await client.close();

const stage = "build/orchard";
rmSync("build", { recursive: true, force: true });
mkdirSync(`${stage}/swift`, { recursive: true });
mkdirSync(`${stage}/dist`, { recursive: true });
cpSync("dist/index.js", `${stage}/dist/index.js`);
cpSync("swift/OrchardHelper.swift", `${stage}/swift/OrchardHelper.swift`);
cpSync("swift/Info.plist", `${stage}/swift/Info.plist`);
cpSync("assets/icon.png", `${stage}/icon.png`);
cpSync("README.md", `${stage}/README.md`);
cpSync("LICENSE", `${stage}/LICENSE`);

const manifest = {
  manifest_version: "0.3",
  name: "orchard",
  display_name: "Orchard",
  version: pkg.version,
  description: "Reminders, Calendar, Notes, Mail, Messages and Contacts on your Mac, for Claude. Native, fast, local.",
  long_description: readFileSync("assets/long_description.md", "utf8"),
  author: { name: "书同文Suwin" },
  license: "MIT",
  keywords: ["apple", "mac", "reminders", "calendar", "notes", "mail", "messages", "imessage", "contacts", "productivity"],
  icon: "icon.png",
  server: {
    type: "node",
    entry_point: "dist/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/dist/index.js"],
      env: { ORCHARD_ALLOW_SEND: "${user_config.allow_sending}" },
    },
  },
  user_config: {
    allow_sending: {
      type: "boolean",
      title: "Allow sending messages and email",
      description: "When off, Claude can only open email drafts for you to review and cannot send iMessages.",
      default: true,
      required: false,
    },
  },
  tools: tools.map((t) => ({ name: t.name, description: t.description.split("\n")[0] })),
  prompts: prompts.map((p) => ({ name: p.name, description: p.description, text: p.name === "plan_my_day" ? "Use apple_today to plan the rest of my day." : "Use Orchard to review my past week and the week ahead." })),
  compatibility: { platforms: ["darwin"], runtimes: { node: ">=20.0.0" } },
};
writeFileSync(`${stage}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
execFileSync("npx", ["mcpb", "validate", `${stage}/manifest.json`], { stdio: "inherit" });
mkdirSync("out", { recursive: true });
const outFile = `out/orchard-${pkg.version}.mcpb`;
rmSync(outFile, { force: true });
execFileSync("npx", ["mcpb", "pack", stage, outFile], { stdio: "inherit" });
console.error(`\nPacked ${outFile} with ${tools.length} tools.`);

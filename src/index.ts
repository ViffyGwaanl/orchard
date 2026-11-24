#!/usr/bin/env node
/**
 * Orchard: Reminders, Calendar, Notes, Mail, Messages and Contacts on a Mac,
 * for Claude. Builds on the ideas of supermemoryai/apple-mcp (MIT), rebuilt
 * around a native EventKit helper.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ensureHelperBuilt } from "./helper/build.js";
import { runRemoteCommand, REMOTE_COMMANDS } from "./remote/cli.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

export { createServer, INSTRUCTIONS } from "./server.js";

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\u0000");
const command = process.argv[2];
if (isMain && command && REMOTE_COMMANDS.has(command)) {
  // Remote mode (claude.ai custom connector): `serve-http`, `remote-init`, `remote-reset`, ...
  runRemoteCommand(command, process.argv.slice(3)).then(
    (code) => {
      if (code !== undefined) process.exit(code);
    },
    (e: Error) => {
      console.error(`orchard: ${e.message}`);
      process.exit(1);
    },
  );
} else if (isMain || process.env.ORCHARD_FORCE_MAIN === "1") {
  serveStdio(createServer);
  console.error(`orchard ${VERSION} running on stdio`);
  // Build the native helper in the background so the first real request is fast.
  ensureHelperBuilt().then(
    (p) => console.error(`orchard helper ready at ${p}`),
    (e: Error) => console.error(`orchard helper not ready: ${e.message}`),
  );
}

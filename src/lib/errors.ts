import type { CallToolResult } from "@modelcontextprotocol/server";
import { HelperError } from "../helper/client.js";
import { HELPER_PATH } from "../helper/build.js";
import { DateInputError } from "./dates.js";

export class ToolInputError extends Error {}

const NEXT_STEPS: Record<string, string> = {
  PERMISSION_DENIED: "Call apple_grant_access for this area, or apple_open_settings to show the right System Settings page.",
  FULL_DISK_ACCESS_REQUIRED: `Call apple_open_settings with pane "full_disk_access". The person then adds this file with the + button: ${HELPER_PATH}`,
  AUTOMATION_DENIED: 'Call apple_open_settings with pane "automation" so the person can turn it on.',
  SWIFT_MISSING: "Ask the person to run `xcode-select --install` in Terminal, then call apple_status.",
  COMPILE_FAILED: "Call apple_status to see the compiler output.",
  APP_NOT_RUNNING: "The app may still be launching. Try once more.",
};

export function errorResult(e: unknown): CallToolResult {
  let msg: string;
  if (e instanceof HelperError) {
    msg = e.message;
    if (e.details) msg += `\n\nDetails:\n${e.details}`;
    const next = NEXT_STEPS[e.code];
    if (next) msg += `\n\nNext step: ${next}`;
    msg = `[${e.code}] ${msg}`;
  } else if (e instanceof DateInputError || e instanceof ToolInputError) {
    msg = e.message;
  } else if (e instanceof Error) {
    msg = `Unexpected error: ${e.message}`;
  } else {
    msg = `Unexpected error: ${String(e)}`;
  }
  return { content: [{ type: "text", text: msg }], isError: true };
}

export function safe<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return errorResult(e);
    }
  };
}

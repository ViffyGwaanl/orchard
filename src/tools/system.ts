import { execFile } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { BUILD_LOG, HELPER_PATH, helperIsCurrent, lastBuild } from "../helper/build.js";
import { call, HelperError } from "../helper/client.js";
import { safe } from "../lib/errors.js";
import { text } from "../lib/format.js";
import { config } from "../config.js";
import { VERSION } from "../version.js";

export interface Status {
  helper_version: string;
  helper_path: string;
  self_responsible: boolean;
  macos: string;
  reminders: string;
  calendars: string;
  contacts: string;
  full_disk_access: { messages_db: string; mail_index: string };
  automation: Record<string, string>;
  time_zone: string;
  now: string;
}

const PANES: Record<string, string> = {
  full_disk_access: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  reminders: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders",
  calendars: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  contacts: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
};

function open(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile("/usr/bin/open", args, (err) => (err ? reject(err) : resolve())));
}

const mark = (s: string) => (s === "granted" ? "✅" : s === "not_determined" || s === "app_not_running" ? "⚪️" : s === "missing" ? "➖" : "⚠️");

const HUMAN: Record<string, string> = {
  granted: "allowed",
  denied: "denied",
  not_determined: "not asked yet",
  restricted: "blocked by a device policy",
  write_only: "add-only (needs full access)",
  app_not_running: "not checked (app closed)",
  missing: "not used on this Mac",
};

export function statusReport(s: Status): string {
  const h = (v: string) => HUMAN[v] ?? v;
  const lines = [
    `# Orchard ${VERSION} · helper ${s.helper_version}`,
    `macOS ${s.macos} · time zone ${s.time_zone} · now ${s.now}`,
    "",
    "## Access",
    `${mark(s.reminders)} Reminders — ${h(s.reminders)}`,
    `${mark(s.calendars)} Calendar — ${h(s.calendars)}`,
    `${mark(s.contacts)} Contacts — ${h(s.contacts)}`,
    `${mark(s.full_disk_access.messages_db)} Messages history (Full Disk Access) — ${h(s.full_disk_access.messages_db)}`,
    `${mark(s.full_disk_access.mail_index)} Fast mail search (Full Disk Access) — ${h(s.full_disk_access.mail_index)}`,
    ...Object.entries(s.automation).map(([app, v]) => `${mark(v)} Control ${app} — ${h(v)}`),
    "",
    `Sending messages and email: ${config.allowSending ? "allowed (always confirm with the person first)" : "turned off in settings (drafts only)"}`,
    `Helper: ${s.helper_path}${s.self_responsible ? "" : " (running without its own privacy identity)"}`,
  ];
  const todo: string[] = [];
  const ask = ["reminders", "calendars", "contacts"].filter((k) => (s as unknown as Record<string, string>)[k] === "not_determined");
  const autoAsk = Object.entries(s.automation).filter(([, v]) => v === "not_determined" || v === "app_not_running").map(([k]) => k);
  if (ask.length || autoAsk.length) todo.push(`Call apple_grant_access with ${JSON.stringify([...ask, ...autoAsk])}; macOS will show a dialog for each, which the person approves.`);
  const denied = ["reminders", "calendars", "contacts"].filter((k) => (s as unknown as Record<string, string>)[k] === "denied");
  if (denied.length) todo.push(`${denied.join(", ")} were denied earlier: apple_open_settings with that pane, then switch on Orchard Helper.`);
  if (Object.values(s.automation).includes("denied")) todo.push('Automation was denied for some apps: apple_open_settings pane "automation", expand Orchard Helper, switch them on.');
  if (s.full_disk_access.messages_db === "denied" || s.full_disk_access.mail_index === "denied") {
    todo.push(`Reading Messages history and fast mail search need Full Disk Access: apple_open_settings pane "full_disk_access" opens the page and shows the helper file in Finder; the person drags it into the list (or clicks + and picks it).`);
  }
  if (todo.length) lines.push("", "## To finish setup", ...todo.map((t) => `- ${t}`));
  else lines.push("", "Everything is set up.");
  return lines.join("\n");
}

export function registerSystemTools(server: McpServer) {
  server.registerTool(
    "apple_status",
    {
      title: "Orchard status and setup check",
      description: "Check that Orchard works on this Mac: native helper build, each privacy permission, the local time and time zone, and exactly what still needs to be switched on. Call this first if any other Orchard tool reports a permission or setup problem.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async () => {
      try {
        const s = await call<Status>("system.status", {}, { timeoutMs: 600_000 });
        // Some macOS releases report "not determined" for a grant that is in fact active.
        // A quick read settles it without changing anything.
        for (const [key, method] of [["reminders", "reminders.lists"], ["calendars", "calendar.calendars"]] as const) {
          if (s[key] !== "not_determined") continue;
          try {
            await call(method, {}, { timeoutMs: 4000 });
            s[key] = "granted";
          } catch {
            /* still not granted, or a dialog is waiting */
          }
        }
        return text(statusReport(s));
      } catch (e) {
        if (e instanceof HelperError) {
          const lines = [`# Orchard ${VERSION}`, `The native helper is not ready: [${e.code}] ${e.message}`];
          if (e.details) lines.push("", "```", e.details.slice(0, 3000), "```");
          lines.push("", `Build log: ${BUILD_LOG}`, `Helper path: ${HELPER_PATH} (${(await helperIsCurrent()) ? "built" : "not built"})`);
          if (lastBuild) lines.push(`Last build: ${lastBuild.ok ? "ok" : "failed"} at ${lastBuild.at}`);
          return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
        }
        throw e;
      }
    }),
  );

  server.registerTool(
    "apple_grant_access",
    {
      title: "Ask macOS for access",
      description: "Trigger the macOS permission dialogs for Orchard Helper (Reminders, Calendars, Contacts, and control of Mail, Notes and Messages). Each dialog waits for the person to click Allow, so tell them to watch for it. Full Disk Access cannot be requested this way; use apple_open_settings.",
      inputSchema: z.strictObject({
        areas: z.array(z.enum(["reminders", "calendars", "contacts", "Mail", "Notes", "Messages"])).min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ areas }) => {
      const lines: string[] = [];
      for (const what of areas) {
        try {
          const r = await call<{ granted?: boolean; status?: string; timed_out?: boolean }>("system.request", { what }, { timeoutMs: 200_000 });
          const ok = r.granted === true || r.status === "granted";
          lines.push(`${ok ? "✅" : "⚠️"} ${what}: ${ok ? "allowed" : r.timed_out ? "no answer to the dialog" : r.status ?? "not allowed"}`);
        } catch (e) {
          lines.push(`⚠️ ${what}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const fail = lines.some((l) => l.startsWith("⚠️"));
      if (fail) lines.push("", "For anything not allowed, call apple_open_settings with the matching pane so the person can switch Orchard Helper on.");
      return text(lines.join("\n"));
    }),
  );

  server.registerTool(
    "apple_open_settings",
    {
      title: "Open the right System Settings page",
      description: "Open the Privacy & Security page where the person can switch on Orchard Helper. For full_disk_access it also reveals the helper file in Finder so it can be dragged into the list.",
      inputSchema: z.strictObject({
        pane: z.enum(["full_disk_access", "automation", "reminders", "calendars", "contacts"]),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ pane }) => {
      await open([PANES[pane]]);
      if (pane === "full_disk_access") {
        await new Promise((r) => setTimeout(r, 800));
        await open(["-R", HELPER_PATH]).catch(() => undefined);
        return text(
          `Opened Full Disk Access and showed "orchard-helper" in Finder.\nAsk the person to drag orchard-helper from the Finder window into the Full Disk Access list (or click +, press ⌘⇧G and paste ${HELPER_PATH}), then make sure its switch is on. Then call apple_status to confirm.`,
        );
      }
      return text(`Opened System Settings › Privacy & Security › ${pane.replace(/_/g, " ")}. Ask the person to switch on Orchard Helper there, then call apple_status.`);
    }),
  );
}

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { call, osa } from "../helper/client.js";
import { NOTES_DB } from "../jxa/notesdb.js";
import { addDays, formatIso, startOfToday, wallFromDate } from "../lib/dates.js";
import { safe } from "../lib/errors.js";
import { oneLine, text, untrusted } from "../lib/format.js";
import { eventLine, type CalEvent } from "./calendar.js";
import { contactBlock, type Contact } from "./contacts.js";
import { mailLine, type MailItem } from "./mail.js";
import { reminderLine, type Reminder } from "./reminders.js";

interface NoteHit { id: string; name: string; modified: string | null; folder: string | null; snippet: string }
interface MsgHit { id: number; date: string | null; from_me: boolean; sender: string; sender_name: string | null; text: string; chat_id?: number; chat_title?: string }

const AREAS = ["reminders", "calendar", "notes", "mail", "messages", "contacts"] as const;

function why(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split(". ")[0].replace(/^\[[A-Z_]+\]\s*/, "");
}

export function registerSearchTool(server: McpServer) {
  server.registerTool(
    "apple_search",
    {
      title: "Search everything",
      description: `Search Reminders, Calendar (past and next year), Notes, Mail, Messages and Contacts for one phrase at once, in parallel, and get the best few matches from each with their ids. Use it when the person asks "find everything about X", "where did I put the Fotor brief", or does not say which app.`,
      inputSchema: z.strictObject({
        query: z.string().min(1).max(200),
        areas: z.array(z.enum(AREAS)).default([...AREAS]).describe("Limit the search to some apps"),
        per_area: z.number().int().min(1).max(20).default(5).describe("Matches to show from each app"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ query, areas, per_area }) => {
      const want = new Set(areas);
      const today = startOfToday();
      const n = per_area;
      const jobs = {
        reminders: () => call<{ total: number; items: Reminder[] }>("reminders.find", { status: "all", query, limit: n, completed_from: wallFromDate(addDays(today, -365), false) }),
        calendar: () => call<{ total: number; items: CalEvent[] }>("calendar.find", { from: wallFromDate(addDays(today, -365), false), to: wallFromDate(addDays(today, 365), false), query, limit: 200 }),
        notes: () => osa<{ total: number; items: NoteHit[] } | { error: string }>("Notes", NOTES_DB, { query, limit: n }, { timeoutS: 40 }),
        mail: () => call<{ items: MailItem[]; has_more: boolean }>("mail.search", { mailbox: "all", query, limit: n }),
        messages: () => call<MsgHit[]>("messages.search", { query, limit: n }),
        contacts: () => call<Contact[]>("contacts.search", { query, limit: Math.min(n, 5) }),
      };
      const keys = AREAS.filter((a) => want.has(a));
      const results = await Promise.allSettled(keys.map((k) => jobs[k]()));
      const out: string[] = [`# "${query}" across your Mac`];
      let hits = 0;
      keys.forEach((k, i) => {
        const r = results[i];
        const head = { reminders: "Reminders", calendar: "Calendar", notes: "Notes", mail: "Mail", messages: "Messages", contacts: "Contacts" }[k];
        if (r.status === "rejected") {
          out.push("", `## ${head}`, `Unavailable: ${why(r.reason)}`);
          return;
        }
        const v = r.value as unknown;
        let body = "";
        let count = 0;
        switch (k) {
          case "reminders": {
            const x = v as { total: number; items: Reminder[] };
            count = x.total;
            body = x.items.map((it) => reminderLine(it)).join("\n");
            break;
          }
          case "calendar": {
            const x = v as { total: number; items: CalEvent[] };
            // Closest to today first: upcoming, then most recent past.
            const now = Date.now();
            const sorted = x.items.slice().sort((p, q) => Math.abs(new Date(p.start).getTime() - now) - Math.abs(new Date(q.start).getTime() - now));
            count = x.total;
            body = sorted.slice(0, n).map((e) => `${eventLine(e)} · ${formatIso(e.start, { dateOnly: true })}`).join("\n");
            break;
          }
          case "notes": {
            const x = v as { total: number; items: NoteHit[] } | { error: string };
            if ("error" in x) {
              out.push("", "## Notes", "Full-text search needs Full Disk Access; notes_search can still match titles.");
              return;
            }
            count = x.total;
            body = untrusted("notes", x.items.map((it) => `- **${it.name}** — ${formatIso(it.modified)}${it.folder ? ` · ${it.folder}` : ""}  \`${it.id}\`${it.snippet ? `\n    ${oneLine(it.snippet, 160)}` : ""}`).join("\n"));
            break;
          }
          case "mail": {
            const x = v as { items: MailItem[]; has_more: boolean };
            count = x.items.length;
            body = untrusted("mail", x.items.map(mailLine).join("\n"));
            if (x.has_more) body += "\n(more in mail_search)";
            break;
          }
          case "messages": {
            const x = v as MsgHit[];
            count = x.length;
            body = untrusted("messages", x.map((m) => `- [${formatIso(m.date)}] ${m.from_me ? "Me" : m.sender_name || m.sender}${m.chat_title ? ` in ${oneLine(m.chat_title, 30)} (chat_id=${m.chat_id})` : ""}: ${oneLine(m.text, 160)}`).join("\n"));
            break;
          }
          case "contacts": {
            const x = v as Contact[];
            count = x.length;
            body = x.map(contactBlock).join("\n");
            break;
          }
        }
        hits += count;
        out.push("", `## ${head}${count ? ` (${count}${count > n ? `, showing ${n}` : ""})` : ""}`, count ? body : "No matches.");
      });
      if (!hits) out.push("", `Nothing on this Mac mentions "${query}". Try a shorter or different word.`);
      return text(out.join("\n"));
    }),
  );
}

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { call } from "../helper/client.js";
import { addDays, startOfToday, wallFromDate, weekday } from "../lib/dates.js";
import { safe } from "../lib/errors.js";
import { oneLine, text, untrusted } from "../lib/format.js";
import { eventLine, type CalEvent } from "./calendar.js";
import { reminderLine, type Reminder } from "./reminders.js";
import { isBulkSender, mailLine, senderStats, type MailItem } from "./mail.js";
import { chatLine, type Chat } from "./messages.js";

function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split(". ")[0];
}

/**
 * Unread mail, triaged: people first (anyone in Contacts, or a personal sender with
 * one or two messages), then a one-line count of newsletters and notifications.
 */
async function mailDigest(): Promise<string> {
  const stats = await senderStats({ unread_only: true, limit: 300 }).catch(() => null);
  if (!stats) {
    const r = await call<{ items: MailItem[]; has_more: boolean }>("mail.search", { mailbox: "inbox", unread_only: true, limit: 10 });
    return r.items.length ? untrusted("mail", r.items.map(mailLine).join("\n")) : "Inbox zero.";
  }
  if (!stats.total) return "Inbox zero. 🎉";
  const known = await call<Record<string, string | null>>("contacts.resolve", { handles: stats.senders.map((x) => x.address) }).catch(() => ({} as Record<string, string | null>));
  const people = stats.senders.filter((x) => known[x.address] || !isBulkSender(x));
  const bulk = stats.senders.filter((x) => !people.includes(x));
  people.sort((x, y) => String(y.latest).localeCompare(String(x.latest)));
  const top = people.slice(0, 6);
  const mails = await Promise.all(top.map((x) =>
    call<{ items: MailItem[] }>("mail.search", { mailbox: "inbox", unread_only: true, from: x.address, limit: 2 }).then((r) => r.items).catch(() => [] as MailItem[]),
  ));
  const lines: string[] = [`${stats.total.toLocaleString("en-US")} unread from ${stats.sender_count.toLocaleString("en-US")} senders.`];
  if (top.length) {
    lines.push("", `From people (${people.length}):`);
    lines.push(untrusted("mail", mails.flat().map((m) => {
      const k = known[(m.from_address ?? "").toLowerCase()];
      return mailLine(k ? { ...m, from_name: `★ ${k}` } : m);
    }).join("\n")));
    if (people.length > top.length) lines.push(`…and ${people.length - top.length} more people. mail_senders lists everyone.`);
  } else {
    lines.push("", "Nothing from people, only automated mail.");
  }
  const bulkTotal = bulk.reduce((n, x) => n + x.count, 0);
  if (bulkTotal) {
    const names = bulk.slice(0, 5).map((x) => `${oneLine(x.name || x.address, 30)} ×${x.count}`).join(", ");
    lines.push("", `Newsletters and notifications: ${bulkTotal.toLocaleString("en-US")} (${names}${bulk.length > 5 ? ", …" : ""}). mail_cleanup can clear a sender in one step.`);
  }
  return lines.join("\n");
}

export function registerTodayTool(server: McpServer) {
  server.registerTool(
    "apple_today",
    {
      title: "Today at a glance",
      description: "One-call briefing for right now: today's calendar (and tomorrow's first events), reminders due today or overdue, unread email in the inbox and unread message conversations. Use it for 'what's on today', a morning plan, or before suggesting what to do next.",
      inputSchema: z.strictObject({
        include: z.array(z.enum(["calendar", "reminders", "mail", "messages"])).default(["calendar", "reminders", "mail", "messages"]),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ include }) => {
      const now = new Date();
      const today = startOfToday(now);
      const t = wallFromDate(today, false);
      const tm = wallFromDate(addDays(today, 1), false);
      const want = new Set(include);
      const [events, tomorrow, reminders, mail, chats] = await Promise.allSettled([
        want.has("calendar") ? call<{ items: CalEvent[] }>("calendar.find", { from: t, to: t, limit: 50 }) : Promise.resolve(null),
        want.has("calendar") ? call<{ items: CalEvent[] }>("calendar.find", { from: tm, to: tm, limit: 3 }) : Promise.resolve(null),
        want.has("reminders") ? call<{ total: number; items: Reminder[] }>("reminders.find", { status: "open", due_to: t, limit: 40 }) : Promise.resolve(null),
        want.has("mail") ? mailDigest() : Promise.resolve(null),
        want.has("messages") ? call<Chat[]>("messages.chats", { unread_only: true, limit: 10 }) : Promise.resolve(null),
      ]);

      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const out: string[] = [`# ${t.y}-${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")} ${weekday(today)} · ${hh}:${mm}`];

      if (want.has("calendar")) {
        out.push("", "## Calendar");
        if (events.status === "fulfilled" && events.value) {
          const items = events.value.items;
          const upcoming = items.filter((e) => e.all_day || new Date(e.end) > now);
          const past = items.length - upcoming.length;
          out.push(upcoming.length ? upcoming.map(eventLine).join("\n") : "Nothing else scheduled today.");
          if (past) out.push(`(${past} earlier event${past === 1 ? "" : "s"} already finished)`);
        } else if (events.status === "rejected") out.push(`Unavailable: ${reason(events.reason)}`);
        if (tomorrow.status === "fulfilled" && tomorrow.value?.items.length) {
          out.push("", "Tomorrow starts with:", tomorrow.value.items.map(eventLine).join("\n"));
        }
      }
      if (want.has("reminders")) {
        out.push("", "## Reminders due today or overdue");
        if (reminders.status === "fulfilled" && reminders.value) {
          out.push(reminders.value.items.length ? reminders.value.items.map((r) => reminderLine(r, today)).join("\n") : "Nothing due. 🎉");
          if (reminders.value.total > reminders.value.items.length) out.push(`…and ${reminders.value.total - reminders.value.items.length} more.`);
        } else if (reminders.status === "rejected") out.push(`Unavailable: ${reason(reminders.reason)}`);
      }
      if (want.has("mail")) {
        out.push("", "## Unread email (inbox)");
        if (mail.status === "fulfilled" && mail.value) out.push(mail.value);
        else if (mail.status === "rejected") out.push(`Unavailable: ${reason(mail.reason)} (needs Full Disk Access for the quick view; mail_search still works on the inbox).`);
      }
      if (want.has("messages")) {
        out.push("", "## Unread messages");
        if (chats.status === "fulfilled" && chats.value) {
          out.push(chats.value.length ? untrusted("messages", chats.value.map(chatLine).join("\n")) : "No unread conversations.");
        } else if (chats.status === "rejected") out.push(`Unavailable: ${reason(chats.reason)}`);
      }
      return text(out.join("\n"));
    }),
  );
}

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { call, HelperError, osa } from "../helper/client.js";
import * as S from "../jxa/mail.js";
import { MAIL_FILE_READ } from "../jxa/mailfile.js";
import { MAIL_BULK, MAIL_SENDERS } from "../jxa/mailstats.js";
import { formatIso, parseWall, wallToDate } from "../lib/dates.js";
import { safe, ToolInputError } from "../lib/errors.js";
import { clip, fail, fitPage, oneLine, text, untrusted } from "../lib/format.js";
import { DATE_HELP, LimitSchema, OffsetSchema } from "./common.js";
import { config } from "../config.js";

export interface MailItem {
  id: number;
  subject: string;
  from: string;
  from_address?: string;
  from_name?: string | null;
  date: string | null;
  read: boolean;
  flagged: boolean;
  preview: string | null;
  mailbox?: { account_id?: string | null; mailbox: string; url?: string };
  to?: string[];
  cc?: string[];
}

interface MailFull {
  id: number;
  subject: string;
  from: string;
  reply_to: string | null;
  to: string[];
  cc: string[];
  date: string | null;
  date_sent: string | null;
  read: boolean | null;
  flagged: boolean | null;
  message_id: string | null;
  mailbox: string | null;
  account: string | null;
  attachments: { name: string | null; mime: string | null; size: number | null; downloaded: boolean | null }[];
  content: string;
}

type ScriptError = { error: string; id?: number };
const isErr = (r: unknown): r is ScriptError => typeof r === "object" && r !== null && "error" in r;

/** Search through Mail's own index when Full Disk Access is granted, else ask Mail itself (inbox only). */
export async function searchMail(params: Record<string, unknown>): Promise<{ items: MailItem[]; has_more: boolean; offset: number; via: "index" | "mail-app" }> {
  try {
    const r = await call<{ items: MailItem[]; has_more: boolean; offset: number }>("mail.search", params);
    return { ...r, via: "index" };
  } catch (e) {
    if (!(e instanceof HelperError) || (e.code !== "FULL_DISK_ACCESS_REQUIRED" && e.code !== "NOT_FOUND")) throw e;
    const box = String(params.mailbox ?? "inbox");
    if (box !== "inbox" && box !== "flagged") {
      throw new HelperError(e.code, `Searching "${box}" needs Mail's index, which requires Full Disk Access for Orchard Helper. Without it only the inbox can be searched. ${e.message}`);
    }
    const since = params.since ? wallToDate(params.since as never).toISOString() : undefined;
    const r = await osa<{ items: MailItem[]; has_more: boolean; offset: number }>("Mail", S.MAIL_INBOX_SEARCH, {
      ...params, flagged_only: params.flagged_only || box === "flagged", since,
    }, { timeoutS: 120 });
    return { ...r, via: "mail-app" };
  }
}

export function mailLine(m: MailItem): string {
  const flags = `${m.read ? "" : "● "}${m.flagged ? "⚑ " : ""}`;
  // Gmail keeps inbox mail in "All Mail" with an INBOX label; that folder name is noise here.
  const name = m.mailbox?.mailbox ?? "";
  const box = name && !/^inbox$|all mail|所有邮件|全部邮件|收件箱/i.test(name) ? ` · ${name}` : "";
  const preview = m.preview ? `\n    ${oneLine(m.preview, 180)}` : "";
  return `- ${flags}**${oneLine(m.subject || "(no subject)", 120)}** — ${oneLine(m.from_name || m.from, 60)} · ${formatIso(m.date)}${box}  \`${m.id}\`${preview}`;
}

function parseAddress(s: string): { address: string; name?: string } {
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return m[1].trim() ? { name: m[1].trim(), address: m[2].trim() } : { address: m[2].trim() };
  return { address: s.trim() };
}

function validAddress(a: { address: string }): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.address);
}

async function metaFor(id: number): Promise<MailItem | undefined> {
  try {
    return await call<MailItem>("mail.get", { id });
  } catch {
    return undefined;
  }
}

function hintOf(meta: MailItem | undefined): { account_id?: string; mailbox?: string } | undefined {
  return meta?.mailbox ? { account_id: meta.mailbox.account_id ?? undefined, mailbox: meta.mailbox.mailbox } : undefined;
}

async function hintFor(id: number) {
  return hintOf(await metaFor(id));
}

async function readMail(id: number, markRead = false): Promise<MailFull | ScriptError> {
  const meta = await metaFor(id);
  const hint = hintOf(meta);
  // Fast path: read the .emlx file directly (needs Full Disk Access, which the index lookup just proved).
  if (hint?.account_id && !markRead) {
    try {
      const r = await osa<MailFull | ScriptError>("Mail", MAIL_FILE_READ, { id, ...hint }, { timeoutS: 30 });
      if (!isErr(r)) {
        return { ...r, date: meta?.date ?? r.date, read: meta?.read ?? null, flagged: meta?.flagged ?? null };
      }
    } catch {
      /* fall back to asking Mail */
    }
  }
  return osa<MailFull | ScriptError>("Mail", S.MAIL_READ, { id, hint, mark_read: markRead });
}

function quote(m: MailFull): string {
  const body = m.content.split("\n").map((l) => `> ${l}`).join("\n");
  return `On ${formatIso(m.date)}, ${m.from} wrote:\n${body}`;
}


export interface SenderStat {
  address: string;
  name: string | null;
  count: number;
  latest: string | null;
  accounts: string[];
}

export async function senderStats(params: { unread_only?: boolean; from?: string; since_unix?: number; limit?: number }): Promise<{ total: number; sender_count: number; senders: SenderStat[] } | null> {
  const r = await osa<{ total: number; sender_count: number; senders: SenderStat[] } | { error: string }>("Mail", MAIL_SENDERS, params, { timeoutS: 40 });
  return "error" in r ? null : r;
}

let accountCache: { at: number; byId: Map<string, string> } | null = null;
export async function accountNames(): Promise<Map<string, string>> {
  if (accountCache && Date.now() - accountCache.at < 10 * 60_000) return accountCache.byId;
  const r = await osa<{ accounts: { id: string; name: string }[] }>("Mail", S.MAIL_ACCOUNTS, {}, { timeoutS: 40 });
  accountCache = { at: Date.now(), byId: new Map(r.accounts.map((a) => [a.id, a.name])) };
  return accountCache.byId;
}

/** Bulk mail is anything from an automated address or a sender with many unread messages. */
export function isBulkSender(s: { address: string; name?: string | null; count?: number }): boolean {
  const a = s.address.toLowerCase();
  if (/(^|[._-])(no-?reply|donotreply|do-not-reply|newsletter|news|notification|notifications|notify|mailer|marketing|promo|promotion|edm|info|service|support|hello|team|bounce|updates?|digest|alerts?)[._@-]/.test(a)) return true;
  if (/@(.*\.)?(mail|email|e|em|news|info|mkt|marketing|edm|notice|notifications?)\./.test(a)) return true;
  if (/广告|\(AD\)|newsletter|通知|订阅/i.test(s.name ?? "")) return true;
  return (s.count ?? 0) >= 4;
}

export function senderLine(s: SenderStat, accounts: Map<string, string>, known?: string | null): string {
  const who = known ? `★ ${known}` : s.name ? s.name : s.address;
  const where = s.accounts.map((id) => accounts.get(id) ?? id.slice(0, 8)).join(", ");
  return `- **${oneLine(who, 50)}** <${s.address}> — ${s.count} · latest ${formatIso(s.latest)}${where ? ` · ${where}` : ""}`;
}

export function registerMailTools(server: McpServer) {
  server.registerTool(
    "mail_list_accounts",
    {
      title: "List mail accounts",
      description: "Show the Mail accounts on this Mac with their mailboxes and unread counts, and the total unread in the inbox.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async () => {
      const r = await osa<{ inbox_unread: number | null; accounts: { id: string; name: string; enabled: boolean; emails: string[]; mailboxes: { name: string; unread: number }[] }[] }>("Mail", S.MAIL_ACCOUNTS, {}, { timeoutS: 90 });
      const lines = [`# Mail · ${r.inbox_unread ?? "?"} unread in Inbox`];
      for (const a of r.accounts) {
        lines.push(`\n## ${a.name}${a.enabled ? "" : " (disabled)"} — ${a.emails.join(", ")}  \`${a.id}\``);
        const boxes = a.mailboxes.filter((b) => b.unread > 0 || /inbox|sent|draft|archive|收件|已发送|草稿|归档/i.test(b.name));
        lines.push(boxes.map((b) => `- ${b.name}${b.unread ? ` (${b.unread} unread)` : ""}`).join("\n") || "- (no mailboxes)");
        if (a.mailboxes.length > boxes.length) lines.push(`- …and ${a.mailboxes.length - boxes.length} more folders`);
      }
      return text(lines.join("\n"));
    }),
  );

  server.registerTool(
    "mail_search",
    {
      title: "Search email",
      description: `Search email across accounts by text, sender, mailbox, read/flag state and date. Results include a short preview; use mail_read for the full message.

Uses Mail's own index (fast, every mailbox) when Full Disk Access is granted, otherwise asks Mail directly (inbox only).

Examples:
  - "Any unread mail today?" -> unread_only=true, since="today"
  - "Emails from Lovart this month" -> from="lovart", since="2026-10-01", mailbox="all"`,
      inputSchema: z.strictObject({
        query: z.string().optional().describe("Text in subject, sender or preview"),
        from: z.string().optional().describe("Sender name or address"),
        mailbox: z.string().default("inbox").describe("inbox, sent, flagged, all, or a folder name"),
        account_id: z.string().optional().describe("Limit to one account (id from mail_list_accounts)"),
        unread_only: z.boolean().default(false),
        flagged_only: z.boolean().default(false),
        since: z.string().optional().describe(`Received on or after. ${DATE_HELP}`),
        until: z.string().optional().describe("Received on or before (inclusive day)"),
        limit: LimitSchema(25, 200),
        offset: OffsetSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const params: Record<string, unknown> = { ...a };
      if (a.since) params.since = parseWall(a.since);
      if (a.until) params.until = parseWall(a.until);
      const r = await searchMail(params);
      if (!r.items.length) return text("No emails match.");
      const note = r.via === "mail-app" ? "\n\n(Searched the inbox through Mail. Grant Full Disk Access to Orchard Helper for instant search across every mailbox with previews.)" : "";
      const page = fitPage(r.items, (its) => {
        const more = r.has_more || its.length < r.items.length ? `\n\nMore: call again with offset=${r.offset + its.length}.` : "";
        return `# ${its.length} email${its.length === 1 ? "" : "s"}${a.unread_only ? " (unread)" : ""}\n${untrusted("mail", its.map(mailLine).join("\n"))}${more}${note}`;
      });
      return text(page.text);
    }),
  );

  server.registerTool(
    "mail_read",
    {
      title: "Read an email",
      description: "Open one email by id (from mail_search) and return its headers, attachment list and plain-text body.",
      inputSchema: z.strictObject({
        id: z.number().int().positive(),
        mark_read: z.boolean().default(false).describe("Also mark it as read in Mail"),
        max_chars: z.number().int().min(500).max(100_000).default(15_000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id, mark_read, max_chars }) => {
      const m = await readMail(id, mark_read);
      if (isErr(m)) return fail(`Email ${id} could not be opened. It may have been moved or deleted (search again), or Mail is still downloading it.`);
      const head = [
        `# ${m.subject || "(no subject)"}`,
        `From: ${m.from}`,
        m.to.length ? `To: ${m.to.join(", ")}` : "",
        m.cc.length ? `Cc: ${m.cc.join(", ")}` : "",
        `Date: ${formatIso(m.date)}${m.account ? ` · ${m.account}` : ""}${m.mailbox ? ` / ${m.mailbox}` : ""}`,
        m.attachments.length ? `Attachments: ${m.attachments.map((x) => `${x.name ?? "file"}${x.size ? ` (${Math.round(x.size / 1024)} KB)` : ""}`).join(", ")}` : "",
      ].filter(Boolean);
      const body = clip(m.content.replace(/\n{3,}/g, "\n\n").trim(), max_chars);
      return text(`${head.join("\n")}\n\n${untrusted("mail", body.text)}${body.clipped ? `\n\n(Truncated at ${max_chars} characters.)` : ""}`);
    }),
  );

  server.registerTool(
    "mail_compose",
    {
      title: "Write an email",
      description: `Write a new email or a reply. By default it opens as a ready-to-send draft window in Mail so the person can review it and press Send. Set send_now=true only when the person has explicitly approved the final recipients and text.

Replies: pass reply_to_id (an id from mail_search); the original sender becomes the recipient (reply_all adds the others), the subject gets "Re:" and the original is quoted below your text.`,
      inputSchema: z.strictObject({
        to: z.array(z.string()).max(50).default([]).describe('Addresses, e.g. "li@example.com" or "Li Wei <li@example.com>"'),
        cc: z.array(z.string()).max(50).default([]),
        bcc: z.array(z.string()).max(50).default([]),
        subject: z.string().max(500).default(""),
        body: z.string().max(100_000).describe("Plain-text body"),
        attachments: z.array(z.string()).max(20).default([]).describe("Absolute file paths on this Mac"),
        from: z.string().optional().describe("Sending address if the person has several accounts"),
        reply_to_id: z.number().int().positive().optional(),
        reply_all: z.boolean().default(false),
        send_now: z.boolean().default(false).describe("Send immediately instead of opening a draft"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async (a) => {
      let to = a.to.map(parseAddress);
      let cc = a.cc.map(parseAddress);
      let subject = a.subject;
      let body = a.body;
      if (a.reply_to_id) {
        const orig = await readMail(a.reply_to_id);
        if (isErr(orig)) return fail(`Could not open email ${a.reply_to_id} to reply to it.`);
        if (!to.length) to = [parseAddress(orig.reply_to || orig.from)];
        if (a.reply_all) {
          const mine = new Set(to.map((x) => x.address.toLowerCase()));
          for (const r of [...orig.to, ...orig.cc].map(parseAddress)) {
            if (!mine.has(r.address.toLowerCase())) cc.push(r);
          }
        }
        if (!subject) subject = /^(re|回复|答复)[:：]/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
        body = `${body}\n\n${quote(orig)}`;
      }
      const bad = [...to, ...cc, ...a.bcc.map(parseAddress)].filter((x) => !validAddress(x));
      if (bad.length) throw new ToolInputError(`These do not look like email addresses: ${bad.map((b) => b.address).join(", ")}. Use contacts_search to find the right address.`);
      if (!to.length && !cc.length && a.bcc.length === 0 && a.send_now) throw new ToolInputError("An email needs at least one recipient before it can be sent.");
      if (a.send_now && !config.allowSending) throw new ToolInputError("Sending is turned off in Orchard's settings. Open a draft instead (send_now=false).");
      const res = await osa<{ sent?: boolean; opened?: boolean }>("Mail", S.MAIL_COMPOSE, {
        to, cc, bcc: a.bcc.map(parseAddress), subject, body, attachments: a.attachments, from: a.from, send_now: a.send_now,
      }, { timeoutS: 90 });
      const who = [...to, ...cc].map((x) => x.name ? `${x.name} <${x.address}>` : x.address).join(", ") || "(no recipients yet)";
      if (a.send_now) return text(res.sent ? `Sent "${subject}" to ${who}.` : `Mail did not confirm sending "${subject}". Check Mail's Outbox.`);
      return text(`Opened a draft in Mail: "${subject}" to ${who}. The person can review and press Send.`);
    }),
  );

  server.registerTool(
    "mail_update",
    {
      title: "Mark, flag, move or trash emails",
      description: "Mark emails read/unread, flag/unflag them, move them to a folder, or move them to Trash. Ids come from mail_search.",
      inputSchema: z.strictObject({
        ids: z.array(z.number().int().positive()).min(1).max(100),
        action: z.enum(["mark_read", "mark_unread", "flag", "unflag", "move", "trash"]),
        mailbox: z.string().optional().describe("Destination folder name for move, e.g. 'Archive'"),
        account: z.string().optional().describe("Account name for the destination folder (defaults to the email's own account)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      if (a.action === "move" && !a.mailbox) throw new ToolInputError("Pass the destination mailbox for move.");
      const hints: Record<string, unknown> = {};
      for (const id of a.ids) {
        const h = await hintFor(id);
        if (h) hints[String(id)] = h;
      }
      const r = await osa<{ done: { id: number; subject: string }[]; failed: { id: number; subject?: string; message: string }[] }>("Mail", S.MAIL_UPDATE, { ...a, hints }, { timeoutS: 180 });
      const verb = { mark_read: "Marked read", mark_unread: "Marked unread", flag: "Flagged", unflag: "Unflagged", move: `Moved to ${a.mailbox}`, trash: "Moved to Trash" }[a.action];
      const lines = [`${verb}: ${r.done.length}`, ...r.done.map((d) => `- ${oneLine(d.subject, 100)}`)];
      if (r.failed.length) lines.push(`Failed: ${r.failed.length}`, ...r.failed.map((f) => `- ${f.subject ? oneLine(f.subject, 80) : f.id}: ${f.message}`));
      return { content: [{ type: "text", text: lines.join("\n") }], isError: r.done.length === 0 };
    }),
  );
  server.registerTool(
    "mail_senders",
    {
      title: "Who is filling the inbox",
      description: `Count inbox email by sender across every account, biggest first, over the whole inbox (not just the latest page). Senders who are in Contacts are starred. Use it to triage a crowded inbox, find newsletters to clean up with mail_cleanup, or answer "who emails me most". Needs Full Disk Access.`,
      inputSchema: z.strictObject({
        unread_only: z.boolean().default(true),
        since: z.string().optional().describe(`Only mail received on or after. ${DATE_HELP}`),
        from: z.string().optional().describe("Only senders whose name or address contains this"),
        limit: LimitSchema(30, 200),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const since_unix = a.since ? Math.floor(wallToDate(parseWall(a.since)).getTime() / 1000) : undefined;
      const r = await senderStats({ unread_only: a.unread_only, from: a.from, since_unix, limit: a.limit });
      if (!r) return fail("Sender counts need Full Disk Access for Orchard Helper. Call apple_open_settings with pane full_disk_access.");
      if (!r.senders.length) return text(a.unread_only ? "No unread mail in the inbox." : "No mail matches.");
      const [accounts, known] = await Promise.all([
        accountNames().catch(() => new Map<string, string>()),
        call<Record<string, string | null>>("contacts.resolve", { handles: r.senders.map((x) => x.address) }).catch(() => ({} as Record<string, string | null>)),
      ]);
      const lines = r.senders.map((x) => senderLine(x, accounts, known[x.address]));
      const head = `# ${r.total.toLocaleString("en-US")} ${a.unread_only ? "unread " : ""}inbox emails from ${r.sender_count.toLocaleString("en-US")} senders`;
      const more = r.sender_count > r.senders.length ? `\n\n…${r.sender_count - r.senders.length} more senders. Raise limit to see them.` : "";
      return text(`${head}\n${untrusted("mail", lines.join("\n"))}${more}\n\n★ = in Contacts.`);
    }),
  );

  server.registerTool(
    "mail_cleanup",
    {
      title: "Clean up mail from one sender",
      description: `Mark read, flag, move or trash every inbox email from one sender, in one step, across accounts. First call without confirm to preview how many emails and which accounts are affected and show that to the person; only call again with confirm=true after they agree.

Example: "Mark everything from FC2 as read" -> from="fc2", action="mark_read", then confirm=true after the person agrees.`,
      inputSchema: z.strictObject({
        from: z.string().min(3).max(200).describe("Text in the sender's name or address, e.g. 'fc2.com' or 'newsletter@example.com'"),
        action: z.enum(["mark_read", "flag", "move", "trash"]),
        unread_only: z.boolean().default(true).describe("Only unread messages (default) or every inbox message from the sender"),
        mailbox: z.string().optional().describe("Destination folder name for move, e.g. 'Archive'"),
        confirm: z.boolean().default(false).describe("false = preview only; true = apply"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      if (a.action === "move" && !a.mailbox) throw new ToolInputError("Pass the destination mailbox for move.");
      const r = await senderStats({ unread_only: a.unread_only, from: a.from, limit: 20 });
      if (!r) return fail("Cleanup needs Full Disk Access for Orchard Helper to find the emails first. Call apple_open_settings with pane full_disk_access.");
      if (!r.total) return text(`No ${a.unread_only ? "unread " : ""}inbox email matches "${a.from}".`);
      const accounts = await accountNames();
      const ids = [...new Set(r.senders.flatMap((x) => x.accounts))];
      const verb = { mark_read: "mark as read", flag: "flag", move: `move to ${a.mailbox}`, trash: "move to Trash" }[a.action];
      const list = r.senders.map((x) => senderLine(x, accounts)).join("\n");
      if (!a.confirm) {
        return text(`Preview: this will ${verb} ${r.total} ${a.unread_only ? "unread " : ""}inbox email${r.total === 1 ? "" : "s"} from:\n${untrusted("mail", list)}\n\nAccounts: ${ids.map((id) => accounts.get(id) ?? id).join(", ")}\nShow this to the person; call again with confirm=true only if they agree.`);
      }
      const done: string[] = [];
      for (const id of ids) {
        const name = accounts.get(id);
        if (!name) {
          done.push(`- ${id}: account not found in Mail, skipped`);
          continue;
        }
        try {
          const res = await osa<{ changed: number }>("Mail", MAIL_BULK, null, {
            lang: "AppleScript", timeoutS: 45, argv: [name, a.from, a.action, a.unread_only ? "1" : "0", a.mailbox ?? ""],
          });
          done.push(`- ${name}: ${res.changed}`);
        } catch (e) {
          const timedOut = e instanceof HelperError && e.code === "TIMEOUT";
          done.push(timedOut
            ? `- ${name}: Mail was still working when the time limit hit, so part of it may be done. Run the preview again to see what is left.`
            : `- ${name}: failed (${e instanceof Error ? e.message.split(". ")[0] : String(e)})`);
        }
      }
      const note = a.action === "trash" ? "\nTrashed mail stays in each account's Trash until it is emptied." : "";
      return text(`Done, ${verb}:\n${done.join("\n")}${note}`);
    }),
  );
}

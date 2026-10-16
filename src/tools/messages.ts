import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { config } from "../config.js";
import { call, HelperError, osa } from "../helper/client.js";
import { MESSAGES_SEND } from "../jxa/messages.js";
import { formatIso, parseWall } from "../lib/dates.js";
import { safe, ToolInputError } from "../lib/errors.js";
import { fitPage, oneLine, text, untrusted } from "../lib/format.js";
import { searchContacts, type Contact } from "./contacts.js";
import { DATE_HELP, LimitSchema, OffsetSchema } from "./common.js";

interface Participant {
  handle: string;
  name: string | null;
  service: string | null;
}

export interface Chat {
  chat_id: number;
  guid: string;
  title: string;
  is_group: boolean;
  participants: Participant[];
  service: string | null;
  unread: number;
  last_message?: { date: string | null; from_me: boolean; text: string };
}

interface Message {
  id: number;
  date: string | null;
  from_me: boolean;
  sender: string;
  sender_name: string | null;
  text: string;
  read: boolean;
  service: string | null;
  attachments?: { name: string | null; mime: string | null; path: string | null }[];
  chat_id?: number;
  chat_title?: string;
}

export function chatLine(c: Chat): string {
  const last = c.last_message;
  const who = last ? (last.from_me ? "me: " : "") : "";
  const lastText = last ? `\n    ${formatIso(last.date)} · ${who}${oneLine(last.text || "(attachment)", 140)}` : "";
  const people = c.is_group ? ` (${c.participants.length} people)` : "";
  return `- **${oneLine(c.title, 80)}**${people}${c.unread ? ` · ${c.unread} unread` : ""} · ${c.service ?? ""}  chat_id=${c.chat_id}${lastText}`;
}

function messageLine(m: Message, showChat = false): string {
  const who = m.from_me ? "Me" : m.sender_name || m.sender;
  const att = m.attachments?.length ? ` [${m.attachments.map((a) => a.name ?? a.mime ?? "attachment").join(", ")}]` : "";
  const chat = showChat && m.chat_title ? ` · in ${oneLine(m.chat_title, 40)} (chat_id=${m.chat_id})` : "";
  return `[${formatIso(m.date)}] ${who}${chat}: ${m.text || ""}${att}`;
}

function isHandle(s: string): boolean {
  return s.includes("@") || s.replace(/[^\d]/g, "").length >= 5;
}

interface Resolved {
  chats: Chat[];
  handles: string[];
  contacts: Contact[];
}

/** Turns "Mom", "+86 138…" or "li@example.com" into existing chats and raw handles. */
async function resolvePerson(who: string): Promise<Resolved> {
  let handles: string[] = [];
  let contacts: Contact[] = [];
  if (isHandle(who)) {
    handles = [who.trim()];
  } else {
    contacts = await searchContacts(who, 5);
    if (!contacts.length) throw new ToolInputError(`No contact matches "${who}". Pass a phone number or email instead, or check the name with contacts_search.`);
    const exact = contacts.filter((c) => c.name === who || c.nickname === who);
    if (exact.length === 1) contacts = exact;
    if (contacts.length > 1) {
      throw new ToolInputError(
        `"${who}" matches several contacts: ${contacts.map((c) => `${c.name} (${[...c.phones.map((p) => p.value), ...c.emails.map((e) => e.value)].slice(0, 3).join(", ")})`).join("; ")}. Ask which one, then pass the phone number or email.`,
      );
    }
    handles = [...contacts[0].phones.map((p) => p.value), ...contacts[0].emails.map((e) => e.value)];
    if (!handles.length) throw new ToolInputError(`${contacts[0].name} has no phone number or email in Contacts.`);
  }
  const chats = await call<Chat[]>("messages.find_chats", { handles });
  return { chats, handles, contacts };
}

export function registerMessagesTools(server: McpServer) {
  server.registerTool(
    "messages_list_chats",
    {
      title: "List message conversations",
      description: "List recent iMessage/SMS conversations with the last message and unread counts. Use unread_only to see what needs a reply. Needs Full Disk Access for Orchard Helper.",
      inputSchema: z.strictObject({
        unread_only: z.boolean().default(false),
        limit: LimitSchema(20, 100),
        offset: OffsetSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const chats = await call<Chat[]>("messages.chats", a);
      if (!chats.length) return text(a.unread_only ? "No unread conversations." : "No conversations found.");
      const page = fitPage(chats, (cs) => {
        const more = cs.length < chats.length || chats.length === a.limit ? `\n\nMore: call again with offset=${a.offset + cs.length}.` : "";
        return `# Conversations\n${untrusted("messages", cs.map(chatLine).join("\n"))}${more}`;
      });
      return text(page.text);
    }),
  );

  server.registerTool(
    "messages_read",
    {
      title: "Read a conversation",
      description: `Read messages from one conversation, oldest to newest. Identify it by chat_id (from messages_list_chats) or by a person: a contact name, phone number or email.

Example: "What did Mom say yesterday?" -> with="Mom", since="yesterday"`,
      inputSchema: z.strictObject({
        chat_id: z.number().int().positive().optional(),
        with: z.string().optional().describe("Contact name, phone number or email"),
        since: z.string().optional().describe(`Only messages on or after. ${DATE_HELP}`),
        before: z.string().optional().describe("Only messages before this time"),
        limit: LimitSchema(50, 500),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      let chatId = a.chat_id;
      let extra = "";
      if (!chatId) {
        if (!a.with) throw new ToolInputError("Pass chat_id or with (a contact name, phone number or email).");
        const r = await resolvePerson(a.with);
        if (!r.chats.length) return text(`No conversation with ${a.with} was found in Messages.`);
        const direct = r.chats.filter((c) => !c.is_group);
        chatId = (direct[0] ?? r.chats[0]).chat_id;
        if (r.chats.length > 1) extra = `\n\nOther conversations with ${a.with}: ${r.chats.filter((c) => c.chat_id !== chatId).map((c) => `${oneLine(c.title, 40)} (chat_id=${c.chat_id})`).join(", ")}`;
      }
      const params: Record<string, unknown> = { chat_id: chatId, limit: a.limit };
      if (a.since) params.since = parseWall(a.since);
      if (a.before) params.before = parseWall(a.before);
      const res = await call<{ chat: Chat; messages: Message[] }>("messages.history", params);
      const who = res.chat.participants.map((p) => (p.name ? `${p.name} (${p.handle})` : p.handle)).join(", ");
      if (!res.messages.length) return text(`# ${res.chat.title}\nNo messages in that range.${extra}`);
      const page = fitPage(res.messages.slice().reverse(), (ms) => {
        const shown = ms.slice().reverse();
        return `# ${res.chat.title}\nWith: ${who} · chat_id=${res.chat.chat_id}\n\n${untrusted("messages", shown.map((m) => messageLine(m)).join("\n"))}${extra}`;
      });
      return text(page.text);
    }),
  );

  server.registerTool(
    "messages_search",
    {
      title: "Search messages",
      description: "Search every iMessage/SMS conversation for text (any language), newest first. Optionally limit to one person or a date.",
      inputSchema: z.strictObject({
        query: z.string().min(1).max(200),
        with: z.string().optional().describe("Only conversations with this contact name, phone or email"),
        since: z.string().optional().describe(DATE_HELP),
        limit: LimitSchema(30, 200),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const params: Record<string, unknown> = { query: a.query, limit: a.limit };
      if (a.since) params.since = parseWall(a.since);
      let results: Message[] = [];
      if (a.with) {
        const r = await resolvePerson(a.with);
        for (const c of r.chats) results.push(...(await call<Message[]>("messages.search", { ...params, chat_id: c.chat_id })));
        results.sort((x, y) => String(y.date).localeCompare(String(x.date)));
        results = results.slice(0, a.limit);
      } else {
        results = await call<Message[]>("messages.search", params);
      }
      if (!results.length) return text(`No messages contain "${a.query}".`);
      return text(`# ${results.length} message${results.length === 1 ? "" : "s"} with "${a.query}"\n${untrusted("messages", results.map((m) => messageLine(m, true)).join("\n"))}`);
    }),
  );

  server.registerTool(
    "messages_send",
    {
      title: "Send a message",
      description: `Send an iMessage (or SMS through a paired iPhone) to a person or an existing conversation, optionally with files.

Before calling, show the person the exact recipient and text and get a clear yes, unless they dictated the exact message themselves. If a name matches several contacts the tool refuses and lists them, so ask which one.`,
      inputSchema: z.strictObject({
        to: z.string().optional().describe("Contact name, phone number (with country code is best) or email"),
        chat_id: z.number().int().positive().optional().describe("Send into an existing conversation, including group chats"),
        text: z.string().max(10_000).default(""),
        attachments: z.array(z.string()).max(10).default([]).describe("Absolute file paths on this Mac"),
        service: z.enum(["imessage", "sms"]).default("imessage").describe("Only used when starting a new conversation"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async (a) => {
      if (!config.allowSending) throw new ToolInputError("Sending messages is turned off in Orchard's settings.");
      if (!a.text.trim() && !a.attachments.length) throw new ToolInputError("Nothing to send: pass text or attachments.");
      if (!a.to && !a.chat_id) throw new ToolInputError("Pass to (a person) or chat_id.");
      let mode: "chat" | "handle";
      let target: string;
      let label: string;
      let chatId: number | undefined = a.chat_id;
      let fallbackHandle: string | undefined;
      if (a.chat_id) {
        const h = await call<{ chat: Chat }>("messages.history", { chat_id: a.chat_id, limit: 1 });
        mode = "chat";
        target = h.chat.guid;
        label = h.chat.title;
        if (!h.chat.is_group) fallbackHandle = h.chat.participants[0]?.handle;
      } else {
        const r = await resolvePerson(a.to!);
        const direct = r.chats.filter((c) => !c.is_group);
        if (direct.length) {
          mode = "chat";
          target = direct[0].guid;
          label = direct[0].title;
          chatId = direct[0].chat_id;
          fallbackHandle = direct[0].participants[0]?.handle;
        } else {
          const phones = r.contacts[0]?.phones.map((p) => p.value) ?? [];
          if (r.contacts.length && phones.length > 1) {
            throw new ToolInputError(`${r.contacts[0].name} has several numbers (${phones.join(", ")}) and no existing conversation. Ask which number to use and pass it as to.`);
          }
          mode = "handle";
          target = r.handles[0];
          label = r.contacts[0] ? `${r.contacts[0].name} (${target})` : target;
        }
      }
      const send = (m: string, t: string) =>
        osa("Messages", MESSAGES_SEND, null, { lang: "AppleScript", raw: true, timeoutS: 60, argv: [a.text, m, t, a.service, ...a.attachments] });
      try {
        await send(mode, target);
      } catch (e) {
        // Some macOS versions name chats differently in AppleScript than in the database;
        // for one-to-one chats, address the person directly instead.
        if (mode === "chat" && fallbackHandle && e instanceof HelperError && e.code === "SCRIPT_ERROR") await send("handle", fallbackHandle);
        else throw e;
      }
      // Confirm delivery state from the database when we can.
      let status = "handed to Messages";
      if (chatId) {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          const h = await call<{ messages: (Message & { error?: number })[] }>("messages.history", { chat_id: chatId, limit: 3 });
          const mine = h.messages.filter((m) => m.from_me).pop();
          if (mine && (a.text ? mine.text.trim() === a.text.trim() : true)) status = "sent";
        } catch {
          /* status stays generic */
        }
      }
      return text(`Message to ${label}: ${status}.${a.attachments.length ? ` ${a.attachments.length} attachment(s).` : ""}`);
    }),
  );
}

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { osa } from "../helper/client.js";
import * as S from "../jxa/notes.js";
import { formatIso } from "../lib/dates.js";
import { safe, ToolInputError } from "../lib/errors.js";
import { clip, fail, fitPage, oneLine, plural, text, untrusted } from "../lib/format.js";
import { escapeHtml, markdownToNotesHtml, notesHtmlToMarkdown } from "../lib/markdown.js";
import { LimitSchema, OffsetSchema } from "./common.js";

interface NoteSummary {
  id: string;
  name: string;
  modified: string | null;
  folder: string | null;
  locked: boolean;
  snippet: string;
}
type ScriptError = { error: string; folder?: string; available?: string[]; id?: string; count?: number };

function scriptError(r: ScriptError): string {
  switch (r.error) {
    case "NO_FOLDER":
      return `There is no Notes folder called "${r.folder}". Folders: ${(r.available ?? []).join(", ")}`;
    case "NOT_FOUND":
      return `No note with id ${r.id}. Use notes_search or notes_list to get current ids.`;
    case "LOCKED":
      return "That note is locked with a password, so its contents cannot be read or changed.";
    case "HAS_ATTACHMENTS":
      return `That note has ${r.count} attachment(s) or image(s), which rewriting its body could drop. Ask the person before retrying with force=true.`;
    default:
      return `Notes reported: ${r.error}`;
  }
}

async function notes<T>(script: string, args: unknown, timeoutS = 60): Promise<T | ScriptError> {
  return osa<T | ScriptError>("Notes", script, args, { timeoutS });
}
const isErr = (r: unknown): r is ScriptError => typeof r === "object" && r !== null && "error" in r;

function summaryLine(n: NoteSummary): string {
  const snip = oneLine(n.snippet.replace(n.name, ""), 160);
  return `- **${n.name || "(untitled)"}** — ${formatIso(n.modified)}${n.folder ? ` · ${n.folder}` : ""}${n.locked ? " · 🔒" : ""}  \`${n.id}\`${snip ? `\n    ${snip}` : ""}`;
}

function titleHtml(title: string): string {
  return `<div><h1>${escapeHtml(title)}</h1></div>`;
}

export function registerNotesTools(server: McpServer) {
  server.registerTool(
    "notes_list_folders",
    {
      title: "List Notes folders",
      description: "Show every Apple Notes folder (including subfolders, across iCloud and other accounts) with note counts.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async () => {
      const res = await notes<{ id: string; name: string; path: string; account: string; count: number | null }[]>(S.NOTES_FOLDERS, {});
      if (isErr(res)) return fail(scriptError(res));
      return text(`# Notes folders\n${res.map((f) => `- ${f.account}/**${f.path}**${f.count !== null ? ` — ${f.count}` : ""}`).join("\n")}`);
    }),
  );

  server.registerTool(
    "notes_list",
    {
      title: "List recent notes",
      description: "List notes, most recently edited first, optionally inside one folder. Each result shows a short preview and the id for notes_read.",
      inputSchema: z.strictObject({
        folder: z.string().optional().describe("Folder name or path, e.g. 'Work' or 'iCloud/Work/Meetings'"),
        limit: LimitSchema(20, 100),
        offset: OffsetSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const res = await notes<{ total: number; items: NoteSummary[] }>(S.NOTES_LIST, a, 90);
      if (isErr(res)) return fail(scriptError(res));
      if (!res.items.length) return text("No notes found.");
      const page = fitPage(res.items, (its) => {
        const more = a.offset + its.length < res.total ? `\n\nMore: call again with offset=${a.offset + its.length}.` : "";
        return `# ${plural(res.total, "note")}${a.folder ? ` in ${a.folder}` : ""}\n${untrusted("notes", its.map(summaryLine).join("\n"))}${more}`;
      });
      return text(page.text);
    }),
  );

  server.registerTool(
    "notes_search",
    {
      title: "Search notes",
      description: "Find notes whose title or text contains the query (any language). Use titles_only for a much faster title search on large libraries.",
      inputSchema: z.strictObject({
        query: z.string().min(1).max(200),
        folder: z.string().optional(),
        titles_only: z.boolean().default(false),
        limit: LimitSchema(20, 100),
        offset: OffsetSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const res = await notes<{ total: number; items: NoteSummary[] }>(S.NOTES_SEARCH, a, 120);
      if (isErr(res)) return fail(scriptError(res));
      if (!res.items.length) return text(`No notes contain "${a.query}".`);
      const page = fitPage(res.items, (its) => {
        const more = a.offset + its.length < res.total ? `\n\nMore: call again with offset=${a.offset + its.length}.` : "";
        return `# ${plural(res.total, "note")} match${res.total === 1 ? "es" : ""} "${a.query}"\n${untrusted("notes", its.map(summaryLine).join("\n"))}${more}`;
      });
      return text(page.text);
    }),
  );

  server.registerTool(
    "notes_read",
    {
      title: "Read a note",
      description: "Read the full contents of a note as Markdown, with its folder, dates and attachment names.",
      inputSchema: z.strictObject({
        id: z.string().min(1),
        max_chars: z.number().int().min(500).max(100_000).default(20_000),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id, max_chars }) => {
      const n = await notes<{ id: string; name: string; folder: string | null; locked: boolean; created: string; modified: string; body: string | null; attachments: (string | null)[] }>(S.NOTES_READ, { id });
      if (isErr(n)) return fail(scriptError(n));
      const head = [`# ${n.name}`, `Folder: ${n.folder ?? "?"} · created ${formatIso(n.created)} · edited ${formatIso(n.modified)}`];
      if (n.attachments.length) head.push(`Attachments: ${n.attachments.map((x) => x ?? "unnamed").join(", ")}`);
      if (n.locked || n.body === null) return text(`${head.join("\n")}\n\n🔒 This note is locked; its contents are not readable.`);
      let md = notesHtmlToMarkdown(n.body);
      const firstLine = md.split("\n")[0].replace(/^#+\s*|\*\*/g, "").trim();
      if (firstLine === n.name.trim()) md = md.split("\n").slice(1).join("\n").trim();
      const c = clip(md, max_chars);
      return text(`${head.join("\n")}\n\n${untrusted("notes", c.text)}${c.clipped ? `\n\n(Truncated at ${max_chars} characters; call again with a larger max_chars for more.)` : ""}`);
    }),
  );

  server.registerTool(
    "notes_create",
    {
      title: "Create a note",
      description: "Create a note from Markdown (headings, bold, italic, lists, links, code, task items). The title becomes the first line.",
      inputSchema: z.strictObject({
        title: z.string().min(1).max(500),
        body: z.string().max(200_000).default("").describe("Markdown content"),
        folder: z.string().optional().describe("Folder name or path. Defaults to the default Notes folder."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe(async (a) => {
      const html = titleHtml(a.title) + markdownToNotesHtml(a.body);
      const res = await notes<{ id: string; name: string; folder: string }>(S.NOTES_CREATE, { folder: a.folder, html });
      if (isErr(res)) return fail(scriptError(res));
      return text(`Created note "${res.name}" in ${res.folder}  \`${res.id}\``);
    }),
  );

  server.registerTool(
    "notes_update",
    {
      title: "Update a note",
      description: "Append to, prepend to (just under the title), or replace a note's contents with Markdown. Replacing can also change the title. Notes with images or attachments are protected unless force=true.",
      inputSchema: z.strictObject({
        id: z.string().min(1),
        body: z.string().max(200_000).describe("Markdown to add, or the new full content for replace"),
        mode: z.enum(["append", "prepend", "replace"]).default("append"),
        title: z.string().min(1).max(500).optional().describe("New title (replace mode only)"),
        force: z.boolean().default(false).describe("Allow rewriting a note that contains attachments"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async (a) => {
      if (a.title && a.mode !== "replace") throw new ToolInputError("A new title can only be set with mode='replace'.");
      const res = await notes<{ id: string; name: string; folder: string }>(S.NOTES_UPDATE, {
        id: a.id, mode: a.mode, force: a.force, html: markdownToNotesHtml(a.body), titleHtml: a.title ? titleHtml(a.title) : undefined,
      });
      if (isErr(res)) return fail(scriptError(res));
      return text(`${a.mode === "replace" ? "Replaced" : a.mode === "append" ? "Appended to" : "Prepended to"} "${res.name}"${res.folder ? ` (${res.folder})` : ""}.`);
    }),
  );

  server.registerTool(
    "notes_move",
    {
      title: "Move a note",
      description: "Move a note into another folder, by folder name or path. notes_list_folders shows the folders.",
      inputSchema: z.strictObject({ id: z.string().min(1), folder: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const res = await notes<{ name: string; folder: string }>(S.NOTES_MOVE, a);
      if (isErr(res)) return fail(scriptError(res));
      return text(`Moved "${res.name}" to ${res.folder}.`);
    }),
  );

  server.registerTool(
    "notes_delete",
    {
      title: "Delete a note",
      description: "Move a note to Recently Deleted (recoverable in Notes for 30 days).",
      inputSchema: z.strictObject({ id: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const res = await notes<{ name: string }>(S.NOTES_DELETE, a);
      if (isErr(res)) return fail(scriptError(res));
      return text(`Moved "${res.name}" to Recently Deleted.`);
    }),
  );
}

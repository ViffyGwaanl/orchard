import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { call } from "../helper/client.js";
import { addDays, describeAlarm, parseWall, startOfToday, wallFromDate, type Wall } from "../lib/dates.js";
import { safe, ToolInputError } from "../lib/errors.js";
import { fitPage, oneLine, plural, text } from "../lib/format.js";
import {
  AlarmsSchema, alarmsToHelper, DATE_HELP, dueLabel, LimitSchema, OffsetSchema, RepeatSchema, repeatToHelper,
  type DueJSON,
} from "./common.js";

export interface Reminder {
  id: string;
  title: string;
  notes: string | null;
  list: string | null;
  list_id: string | null;
  completed: boolean;
  completed_at: string | null;
  priority: "high" | "medium" | "low" | "none";
  due: DueJSON | null;
  url: string | null;
  alarms: { relative_minutes?: number; at?: string }[];
  recurrence: { frequency: string; interval: number; days_of_week?: number[]; until?: string; count?: number } | null;
}

interface ReminderList {
  id: string;
  title: string;
  color: string | null;
  source: string | null;
  default: boolean;
  open_count: number;
}

const DAY_NAMES = ["", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function repeatLabel(r: Reminder["recurrence"]): string {
  if (!r) return "";
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[r.frequency] ?? r.frequency;
  let s = r.interval > 1 ? `every ${r.interval} ${unit}s` : `every ${unit}`;
  if (r.days_of_week?.length) s += ` on ${r.days_of_week.map((d) => DAY_NAMES[d]).join("/")}`;
  if (r.until) s += ` until ${r.until}`;
  if (r.count) s += `, ${r.count} times`;
  return s;
}

export function reminderLine(r: Reminder, today = startOfToday()): string {
  const box = r.completed ? "[x]" : "[ ]";
  const parts: string[] = [];
  if (r.due) {
    const dueAt = new Date(`${r.due.date}T${r.due.time ?? "00:00"}:00`);
    const overdue = !r.completed && (r.due.time ? dueAt < new Date() : dueAt < today);
    parts.push(`due ${dueLabel(r.due)}${overdue ? " ⚠️ overdue" : ""}`);
  }
  if (r.priority !== "none") parts.push(`${r.priority} priority`);
  if (r.list) parts.push(`list: ${r.list}`);
  if (r.alarms?.length) parts.push(`alerts: ${r.alarms.map(describeAlarm).join(", ")}`);
  if (r.recurrence) parts.push(`repeats ${repeatLabel(r.recurrence)}`);
  if (r.completed && r.completed_at) parts.push(`done ${r.completed_at.slice(0, 10)}`);
  let line = `- ${box} **${r.title}**${parts.length ? ` — ${parts.join(" · ")}` : ""}  \`${r.id}\``;
  if (r.notes) line += `\n    ${oneLine(r.notes, 200)}`;
  if (r.url) line += `\n    ${r.url}`;
  return line;
}

type When = "overdue" | "today" | "today_and_overdue" | "tomorrow" | "this_week" | "next_7_days" | "no_date" | "any";

function windowFor(when: When, now = new Date()): { from?: Wall; to?: Wall; undatedOnly?: boolean } {
  const today = startOfToday(now);
  const w = (d: Date) => wallFromDate(d, false);
  switch (when) {
    case "overdue": return { to: w(addDays(today, -1)) };
    case "today": return { from: w(today), to: w(today) };
    case "today_and_overdue": return { to: w(today) };
    case "tomorrow": return { from: w(addDays(today, 1)), to: w(addDays(today, 1)) };
    case "this_week": {
      const dow = (today.getDay() + 6) % 7; // Monday = 0
      return { from: w(addDays(today, -dow)), to: w(addDays(today, 6 - dow)) };
    }
    case "next_7_days": return { from: w(today), to: w(addDays(today, 6)) };
    case "no_date": return { undatedOnly: true };
    default: return {};
  }
}

const ReminderFields = {
  notes: z.string().max(20_000).nullable().optional().describe("Extra details. null clears them."),
  list: z.string().optional().describe("Reminder list name, e.g. 'Work'. Defaults to the person's default list."),
  due: z.string().nullable().optional().describe(`Due date. ${DATE_HELP} null clears it.`),
  alarms: AlarmsSchema.optional().describe(
    'Alerts, e.g. ["-2d"] to be reminded two days before. Relative alerts on all-day items fire at 09:00. If omitted on create and the due date has a time, one alert is added at the due time.',
  ),
  priority: z.enum(["high", "medium", "low", "none"]).optional(),
  url: z.string().nullable().optional().describe("A link to attach"),
  repeat: RepeatSchema.nullable().optional().describe("Make it repeat (needs a due date). null stops repeating."),
};

const CreateItem = z.strictObject({
  title: z.string().min(1).max(1000),
  ...ReminderFields,
});

function buildFields(input: {
  notes?: string | null; list?: string; due?: string | null; alarms?: string[]; priority?: string;
  url?: string | null; repeat?: z.infer<typeof RepeatSchema> | null; title?: string; completed?: boolean;
}, opts: { isCreate: boolean; existingDue?: Wall | null }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.title !== undefined) out.title = input.title;
  if (input.notes !== undefined) out.notes = input.notes;
  if (input.list !== undefined) out.list = input.list;
  if (input.priority !== undefined) out.priority = input.priority;
  if (input.url !== undefined) out.url = input.url ?? "";
  if (input.completed !== undefined) out.completed = input.completed;
  let due: Wall | null | undefined = undefined;
  if (input.due !== undefined) {
    due = input.due === null ? null : parseWall(input.due);
    out.due = due;
  }
  const anchor = due === undefined ? opts.existingDue ?? null : due;
  if (input.alarms !== undefined) {
    out.alarms = alarmsToHelper(input.alarms, anchor);
  } else if (opts.isCreate && due && due.H !== undefined) {
    out.alarms = [{ relative_minutes: 0 }];
  }
  if (input.repeat !== undefined) {
    if (input.repeat && !anchor) throw new ToolInputError("A repeating reminder needs a due date.");
    out.recurrence = repeatToHelper(input.repeat);
  }
  return out;
}

function wallFromDue(d: DueJSON | null): Wall | null {
  if (!d) return null;
  const [y, m, day] = d.date.split("-").map(Number);
  const w: Wall = { y, m, d: day };
  if (d.time) {
    const [H, M] = d.time.split(":").map(Number);
    w.H = H;
    w.M = M;
  }
  return w;
}

export function registerReminderTools(server: McpServer) {
  server.registerTool(
    "reminders_list_lists",
    {
      title: "List reminder lists",
      description: "Show every reminder list (Inbox, Work, …) with its number of open reminders and which one is the default.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async () => {
      const lists = await call<ReminderList[]>("reminders.lists");
      const lines = lists.map((l) => `- **${l.title}**${l.default ? " (default)" : ""} — ${plural(l.open_count, "open reminder")}${l.source ? ` · ${l.source}` : ""}  \`${l.id}\``);
      return text(`# Reminder lists\n${lines.join("\n")}`);
    }),
  );

  server.registerTool(
    "reminders_find",
    {
      title: "Find reminders",
      description: `Find reminders by time window, list, text or priority. Returns ids for reminders_update, reminders_complete and reminders_delete.

Examples:
  - "What's due today?" -> when="today_and_overdue"
  - "Show my Work list" -> list="Work"
  - "Anything about the contract?" -> query="contract", status="all"
  - "What did I finish this week?" -> status="completed", completed_since="-7d"`,
      inputSchema: z.strictObject({
        when: z.enum(["overdue", "today", "today_and_overdue", "tomorrow", "this_week", "next_7_days", "no_date", "any"]).default("any").describe("Due-date window"),
        due_from: z.string().optional().describe(`Custom window start (inclusive). ${DATE_HELP}`),
        due_to: z.string().optional().describe("Custom window end (inclusive day)"),
        list: z.string().optional().describe("Only this list (name)"),
        query: z.string().optional().describe("Text to match in title or notes"),
        priority: z.enum(["high", "medium", "low", "none"]).optional(),
        status: z.enum(["open", "completed", "all"]).default("open"),
        completed_since: z.string().optional().describe("For completed reminders: how far back to look (default 30 days)"),
        limit: LimitSchema(50, 500),
        offset: OffsetSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const win = windowFor(a.when);
      const params: Record<string, unknown> = { status: a.status, limit: win.undatedOnly ? 500 : a.limit, offset: win.undatedOnly ? 0 : a.offset };
      if (a.list) params.lists = [a.list];
      if (a.query) params.query = a.query;
      if (a.priority) params.priority = a.priority;
      if (a.due_from || a.due_to) {
        if (a.due_from) params.due_from = parseWall(a.due_from);
        if (a.due_to) params.due_to = parseWall(a.due_to);
      } else {
        if (win.from) params.due_from = win.from;
        if (win.to) params.due_to = win.to;
      }
      if (a.completed_since) params.completed_from = parseWall(a.completed_since);
      const res = await call<{ total: number; offset: number; items: Reminder[] }>("reminders.find", params);
      let items = res.items;
      let total = res.total;
      let offset = res.offset;
      if (win.undatedOnly) {
        const undated = items.filter((r) => !r.due);
        total = undated.length;
        offset = a.offset;
        items = undated.slice(a.offset, a.offset + a.limit);
      }
      if (!items.length) return text(`No ${a.status === "all" ? "" : `${a.status} `}reminders match.`);
      const today = startOfToday();
      const page = fitPage(items, (its) => {
        const head = `# ${plural(total, `${a.status === "all" ? "" : `${a.status} `}reminder`)}${total > its.length ? ` (showing ${offset + 1}–${offset + its.length})` : ""}`;
        const more = offset + its.length < total ? `\n\nMore: call again with offset=${offset + its.length}.` : "";
        return `${head}\n${its.map((r) => reminderLine(r, today)).join("\n")}${more}`;
      });
      return text(page.text);
    }),
  );

  server.registerTool(
    "reminders_create",
    {
      title: "Create reminders",
      description: `Create one or more reminders in a single call (up to 50). Supports due dates with or without a time, several alerts each (absolute or relative such as two days before), priority, notes, links, lists and repeats.

Examples:
  - "Remind me to pay rent on the 15th, two days early" -> items=[{title:"Pay rent", due:"2026-10-15", alarms:["-2d"]}]
  - "Add three tasks to Work for tomorrow" -> three items with list:"Work", due:"tomorrow"
  - "Water the plants every Monday at 8" -> {title:"Water plants", due:"2026-10-19 08:00", repeat:{frequency:"weekly", days_of_week:["mon"]}}`,
      inputSchema: z.strictObject({
        items: z.array(CreateItem).min(1).max(50).describe("Reminders to create"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ items }) => {
      const payload = items.map((it) => ({ title: it.title, ...buildFields(it, { isCreate: true }) }));
      const res = await call<{ created: Reminder[]; failed: { index: number; title: string; message: string }[] }>("reminders.create", { items: payload });
      const lines: string[] = [];
      if (res.created.length) lines.push(`Created ${plural(res.created.length, "reminder")}:`, ...res.created.map((r) => reminderLine(r)));
      if (res.failed.length) lines.push("", `Failed ${res.failed.length}:`, ...res.failed.map((f) => `- ${f.title || `#${f.index + 1}`}: ${f.message}`));
      return { content: [{ type: "text", text: lines.join("\n") }], isError: res.created.length === 0 };
    }),
  );

  server.registerTool(
    "reminders_update",
    {
      title: "Update a reminder",
      description: "Change a reminder's title, notes, due date, alerts, priority, list, link or repeat. Only the fields you pass change; pass null to clear a field. Get the id from reminders_find.",
      inputSchema: z.strictObject({
        id: z.string().min(1).describe("Reminder id from reminders_find"),
        title: z.string().min(1).max(1000).optional(),
        ...ReminderFields,
        completed: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      let existingDue: Wall | null = null;
      if (a.alarms !== undefined && a.due === undefined) {
        // Relative alerts need the current due date as their anchor.
        const cur = await call<Reminder>("reminders.get", { id: a.id });
        existingDue = wallFromDue(cur.due);
      }
      const fields = buildFields(a, { isCreate: false, existingDue });
      if (!Object.keys(fields).length) throw new ToolInputError("Nothing to change: pass at least one field to update.");
      const r = await call<Reminder>("reminders.update", { id: a.id, ...fields });
      return text(`Updated:\n${reminderLine(r)}`);
    }),
  );

  server.registerTool(
    "reminders_complete",
    {
      title: "Complete reminders",
      description: "Mark one or more reminders as done (or not done again with completed=false).",
      inputSchema: z.strictObject({
        ids: z.array(z.string().min(1)).min(1).max(100),
        completed: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ ids, completed }) => {
      const res = await call<{ changed: { id: string; title: string }[]; failed: { id: string; message: string }[] }>("reminders.complete", { ids, completed });
      const lines = res.changed.map((c) => `- ${completed ? "✓" : "↺"} ${c.title}`);
      if (res.failed.length) lines.push(...res.failed.map((f) => `- ✗ ${f.id}: ${f.message}`));
      return { content: [{ type: "text", text: `${completed ? "Completed" : "Reopened"} ${res.changed.length}:\n${lines.join("\n")}` }], isError: res.changed.length === 0 };
    }),
  );

  server.registerTool(
    "reminders_delete",
    {
      title: "Delete reminders",
      description: "Permanently delete reminders by id. Prefer reminders_complete for finished tasks; delete only when the person asks to remove them.",
      inputSchema: z.strictObject({ ids: z.array(z.string().min(1)).min(1).max(100) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ ids }) => {
      const res = await call<{ deleted: { id: string; title: string }[]; failed: { id: string; message: string }[] }>("reminders.delete", { ids });
      const lines = res.deleted.map((d) => `- 🗑 ${d.title}`);
      if (res.failed.length) lines.push(...res.failed.map((f) => `- ✗ ${f.id}: ${f.message}`));
      return { content: [{ type: "text", text: `Deleted ${res.deleted.length}:\n${lines.join("\n")}` }], isError: res.deleted.length === 0 };
    }),
  );

  server.registerTool(
    "reminders_manage_list",
    {
      title: "Create, rename or delete a reminder list",
      description: "Create a new reminder list, rename one, or delete one (deleting removes every reminder in it, so confirm with the person first).",
      inputSchema: z.strictObject({
        action: z.enum(["create", "rename", "delete"]),
        list: z.string().optional().describe("Existing list name (rename/delete)"),
        name: z.string().optional().describe("New name (create/rename)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async (a) => {
      if (a.action !== "create" && !a.list) throw new ToolInputError("Pass the list to rename or delete.");
      if (a.action !== "delete" && !a.name) throw new ToolInputError("Pass the new name.");
      const res = await call<Record<string, unknown>>("reminders.manage_list", a);
      if (a.action === "delete") return text(`Deleted the list "${res.deleted}".`);
      return text(`${a.action === "create" ? "Created" : "Renamed to"} "${res.title}"  \`${res.id}\``);
    }),
  );
}

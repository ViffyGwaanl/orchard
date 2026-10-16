import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { call } from "../helper/client.js";
import { addDays, describeAlarm, formatIso, parseWall, startOfToday, wallFromDate, weekday, type Wall } from "../lib/dates.js";
import { safe, ToolInputError } from "../lib/errors.js";
import { fitPage, oneLine, plural, text } from "../lib/format.js";
import { AlarmsSchema, alarmsToHelper, DATE_HELP, LimitSchema, OffsetSchema, RepeatSchema, repeatToHelper } from "./common.js";

export interface CalEvent {
  id: string;
  title: string;
  calendar: string | null;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  notes: string | null;
  url: string | null;
  recurring: boolean;
  occurrence_date: string | null;
  alarms: { relative_minutes?: number; at?: string }[];
  attendees?: { name: string | null; email: string; status: number }[];
  organizer?: string;
}

interface Calendar {
  id: string;
  title: string;
  color: string | null;
  source: string | null;
  writable: boolean;
  default: boolean;
}

export function eventLine(e: CalEvent): string {
  const start = new Date(e.start);
  const end = new Date(e.end);
  let when: string;
  if (e.all_day) {
    const lastDay = addDays(end, 0);
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    when = days > 1 ? `all day until ${formatIso(lastDay.toISOString(), { dateOnly: true })}` : "all day";
  } else {
    const sameDay = start.toDateString() === end.toDateString();
    when = `${formatIso(e.start).slice(11)}–${sameDay ? formatIso(e.end).slice(11) : formatIso(e.end)}`;
  }
  const parts = [when];
  if (e.location) parts.push(`📍 ${oneLine(e.location, 80)}`);
  if (e.calendar) parts.push(e.calendar);
  if (e.recurring) parts.push("repeats");
  if (e.alarms?.length) parts.push(`alerts: ${e.alarms.map(describeAlarm).join(", ")}`);
  let line = `- **${e.title}** — ${parts.join(" · ")}  \`${e.id}\``;
  if (e.recurring && e.occurrence_date) line += ` (occurrence ${formatIso(e.occurrence_date, { dateOnly: true })})`;
  if (e.attendees?.length) line += `\n    with ${e.attendees.map((a) => a.name || a.email).slice(0, 8).join(", ")}`;
  if (e.notes) line += `\n    ${oneLine(e.notes, 160)}`;
  if (e.url) line += `\n    ${e.url}`;
  return line;
}

export function groupByDay(events: CalEvent[]): string {
  const groups = new Map<string, CalEvent[]>();
  for (const e of events) {
    const d = new Date(e.start);
    const key = `${formatIso(e.start, { dateOnly: true })} ${weekday(d)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  return [...groups.entries()].map(([day, es]) => `### ${day}\n${es.map(eventLine).join("\n")}`).join("\n\n");
}

const EventFields = {
  end: z.string().optional().describe(`End time. Defaults to one hour after start (timed) or the same day (all day). ${DATE_HELP}`),
  all_day: z.boolean().optional().describe("All-day event. Implied when start has no time."),
  location: z.string().nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
  url: z.string().nullable().optional(),
  calendar: z.string().optional().describe("Calendar name. Defaults to the default calendar."),
  alarms: AlarmsSchema.optional().describe('Alerts before the start, e.g. ["-15m"] or ["-1d","-1h"].'),
  repeat: RepeatSchema.nullable().optional(),
};

function eventFields(a: {
  title?: string; start?: string; end?: string; all_day?: boolean; location?: string | null; notes?: string | null;
  url?: string | null; calendar?: string; alarms?: string[]; repeat?: z.infer<typeof RepeatSchema> | null;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (a.title !== undefined) out.title = a.title;
  let start: Wall | undefined;
  if (a.start !== undefined) {
    start = parseWall(a.start);
    out.start = start;
  }
  if (a.end !== undefined) out.end = parseWall(a.end);
  if (a.all_day !== undefined) out.all_day = a.all_day;
  if (a.location !== undefined) out.location = a.location;
  if (a.notes !== undefined) out.notes = a.notes;
  if (a.url !== undefined) out.url = a.url ?? "";
  if (a.calendar !== undefined) out.calendar = a.calendar;
  if (a.alarms !== undefined) {
    // Event alerts are relative to the start, which EventKit handles natively.
    out.alarms = alarmsToHelper(a.alarms, start ? { ...start, H: start.H ?? 9, M: start.M ?? 0 } : { y: 2000, m: 1, d: 1, H: 0, M: 0 });
  }
  if (a.repeat !== undefined) out.recurrence = repeatToHelper(a.repeat);
  return out;
}

export function registerCalendarTools(server: McpServer) {
  server.registerTool(
    "calendar_list_calendars",
    {
      title: "List calendars",
      description: "Show every calendar on this Mac (iCloud, Google, Exchange, subscribed…) and which ones can be edited.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async () => {
      const cals = await call<Calendar[]>("calendar.calendars");
      return text(`# Calendars\n${cals.map((c) => `- **${c.title}**${c.default ? " (default)" : ""}${c.writable ? "" : " (read-only)"}${c.source ? ` · ${c.source}` : ""}  \`${c.id}\``).join("\n")}`);
    }),
  );

  server.registerTool(
    "calendar_find_events",
    {
      title: "Find calendar events",
      description: `List events in a date range, grouped by day, optionally filtered by text or calendar. Defaults to the next 7 days.

Examples:
  - "What's on my calendar tomorrow?" -> from="tomorrow", to="tomorrow"
  - "When is the dentist?" -> query="dentist", from="today", to="+90d"`,
      inputSchema: z.strictObject({
        from: z.string().default("today").describe(`Start of the range. ${DATE_HELP}`),
        to: z.string().optional().describe("End of the range (inclusive day). Default: 7 days after from."),
        query: z.string().optional().describe("Text to match in title, location or notes"),
        calendars: z.array(z.string()).optional().describe("Only these calendar names"),
        limit: LimitSchema(100, 500),
        offset: OffsetSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const from = parseWall(a.from);
      const to = a.to ? parseWall(a.to) : wallFromDate(addDays(new Date(from.y, from.m - 1, from.d), 6), false);
      const res = await call<{ total: number; offset: number; items: CalEvent[] }>("calendar.find", {
        from, to, query: a.query, calendars: a.calendars, limit: a.limit, offset: a.offset,
      });
      if (!res.items.length) return text(`No events between ${a.from} and ${a.to ?? "7 days later"}${a.query ? ` matching "${a.query}"` : ""}.`);
      const page = fitPage(res.items, (its) => {
        const more = res.offset + its.length < res.total ? `\n\nMore: call again with offset=${res.offset + its.length}.` : "";
        return `# ${plural(res.total, "event")}\n${groupByDay(its)}${more}`;
      });
      return text(page.text);
    }),
  );

  server.registerTool(
    "calendar_create_event",
    {
      title: "Create a calendar event",
      description: `Add an event. A start without a time makes an all-day event. Alerts are relative to the start ("-15m", "-1d") or absolute.

Example: "Lunch with Li Wei Friday 12:30 at Taikoo Li, remind me an hour before" -> title="Lunch with Li Wei", start="2026-10-23 12:30", end="2026-10-23 13:30", location="Taikoo Li", alarms=["-1h"]`,
      inputSchema: z.strictObject({
        title: z.string().min(1).max(1000),
        start: z.string().describe(`Start. ${DATE_HELP}`),
        ...EventFields,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe(async (a) => {
      const e = await call<CalEvent>("calendar.create", eventFields(a));
      return text(`Created:\n${eventLine(e)}\n    ${formatIso(e.start, { dateOnly: true })} ${weekday(new Date(e.start))}`);
    }),
  );

  server.registerTool(
    "calendar_update_event",
    {
      title: "Update a calendar event",
      description: "Change an event's time, title, place, notes, calendar, alerts or repeat. For a repeating event pass occurrence_date to pick one occurrence and span='future' to change it and every later one.",
      inputSchema: z.strictObject({
        id: z.string().min(1).describe("Event id from calendar_find_events"),
        occurrence_date: z.string().optional().describe("For repeating events: the day of the occurrence to change"),
        span: z.enum(["this", "future"]).default("this"),
        title: z.string().min(1).max(1000).optional(),
        start: z.string().optional().describe(`New start. ${DATE_HELP}`),
        ...EventFields,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const fields = eventFields(a);
      if (!Object.keys(fields).length) throw new ToolInputError("Nothing to change: pass at least one field.");
      const e = await call<CalEvent>("calendar.update", {
        id: a.id, span: a.span, ...(a.occurrence_date ? { occurrence_date: parseWall(a.occurrence_date) } : {}), ...fields,
      });
      return text(`Updated:\n${eventLine(e)}`);
    }),
  );

  server.registerTool(
    "calendar_delete_event",
    {
      title: "Delete a calendar event",
      description: "Delete an event. For a repeating event, pass occurrence_date and span ('this' removes one occurrence, 'future' removes it and all later ones).",
      inputSchema: z.strictObject({
        id: z.string().min(1),
        occurrence_date: z.string().optional(),
        span: z.enum(["this", "future"]).default("this"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const res = await call<{ deleted: CalEvent }>("calendar.delete", {
        id: a.id, span: a.span, ...(a.occurrence_date ? { occurrence_date: parseWall(a.occurrence_date) } : {}),
      });
      return text(`Deleted "${res.deleted.title}" (${formatIso(res.deleted.start)}).`);
    }),
  );
}

export function todayRange(): { from: Wall; to: Wall } {
  const t = wallFromDate(startOfToday(), false);
  return { from: t, to: t };
}

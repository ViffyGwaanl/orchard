import * as z from "zod/v4";
import { parseAlarm, parseWall, WEEKDAY_NUMBERS, type AlarmSpec, type Wall } from "../lib/dates.js";
import { ToolInputError } from "../lib/errors.js";

export const DATE_HELP =
  "Local Mac time. Accepts YYYY-MM-DD (all day), YYYY-MM-DD HH:MM, an ISO timestamp, today/tomorrow (optionally with a time), or +3d/-2h offsets.";

export const RepeatSchema = z
  .strictObject({
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(99).default(1).describe("Every N days/weeks/months/years"),
    days_of_week: z
      .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
      .optional()
      .describe("For weekly repeats, e.g. ['mon','wed','fri']"),
    until: z.string().optional().describe("Last day the repeat runs, YYYY-MM-DD"),
    count: z.number().int().min(1).max(999).optional().describe("Stop after this many occurrences"),
  })
  .describe("How the item repeats");

export type Repeat = z.infer<typeof RepeatSchema>;

export function repeatToHelper(r: Repeat | null | undefined): Record<string, unknown> | null {
  if (!r) return null;
  const out: Record<string, unknown> = { frequency: r.frequency, interval: r.interval ?? 1 };
  if (r.days_of_week?.length) out.days_of_week = r.days_of_week.map((d) => WEEKDAY_NUMBERS[d]);
  if (r.until) out.until = parseWall(r.until);
  else if (r.count) out.count = r.count;
  return out;
}

export const AlarmsSchema = z
  .array(z.string().min(1).max(40))
  .max(10)
  .describe(
    'Notification times. Relative: "-2d", "-1h", "-30m", "-1w" (before the due date/start), "0" (exactly at it). Absolute: "2026-10-18 09:00". An empty array removes all alerts.',
  );

/**
 * Converts alarm strings to helper specs. Relative alarms on an all-day item
 * fire at 09:00 local time on the target day instead of at midnight, which is
 * what people mean by "remind me two days before".
 */
export function alarmsToHelper(alarms: string[], anchor: Wall | null, now = new Date()): AlarmSpec[] {
  return alarms.map((a) => {
    const spec = parseAlarm(a, now);
    if ("relative_minutes" in spec && anchor) {
      if (anchor.H === undefined) {
        const base = new Date(anchor.y, anchor.m - 1, anchor.d, 9, 0);
        const t = new Date(base.getTime() + spec.relative_minutes * 60_000);
        return { at: { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), H: t.getHours(), M: t.getMinutes() } };
      }
    } else if ("relative_minutes" in spec && !anchor) {
      throw new ToolInputError(`The alert "${a}" is relative, but there is no due date or start time to count from. Give a due date or use an absolute time like "2026-10-18 09:00".`);
    }
    return spec;
  });
}

export const LimitSchema = (def: number, max: number) =>
  z.number().int().min(1).max(max).default(def).describe("Maximum number of results");
export const OffsetSchema = z.number().int().min(0).default(0).describe("Results to skip, for paging");

export interface DueJSON {
  date: string;
  time: string | null;
  all_day: boolean;
  iso: string;
}

export function dueLabel(due: DueJSON | null | undefined): string {
  if (!due) return "";
  const d = new Date(`${due.date}T00:00:00`);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return `${due.date} (${wd})${due.time ? ` ${due.time}` : ""}`;
}

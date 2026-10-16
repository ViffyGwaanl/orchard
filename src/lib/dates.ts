/**
 * Date handling. Everything the helper receives is a wall-clock date in the
 * Mac's own time zone ({y, m, d, H?, M?}), so there is never any guessing about
 * offsets between Node, Swift and the person.
 */

export interface Wall {
  y: number;
  m: number;
  d: number;
  H?: number;
  M?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function wallFromDate(date: Date, withTime: boolean): Wall {
  const w: Wall = { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
  if (withTime) {
    w.H = date.getHours();
    w.M = date.getMinutes();
  }
  return w;
}

export function wallToDate(w: Wall): Date {
  return new Date(w.y, w.m - 1, w.d, w.H ?? 0, w.M ?? 0, 0, 0);
}

export function wallToString(w: Wall): string {
  const day = `${w.y}-${pad(w.m)}-${pad(w.d)}`;
  return w.H === undefined ? day : `${day} ${pad(w.H)}:${pad(w.M ?? 0)}`;
}

function validDay(y: number, m: number, d: number): boolean {
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}

export class DateInputError extends Error {}

/**
 * Accepts:
 *   2026-10-20 · 2026/10/20 · 2026-10-20 09:30 · 2026-10-20T09:30[:00]
 *   ISO 8601 with an offset or Z (converted to the Mac's local time)
 *   today · tomorrow · yesterday · today 18:00 · tomorrow 9:00
 *   今天 · 明天 · 后天 · 昨天 (optionally followed by a time)
 *   +3d / -1w / +2h style offsets from now
 */
export function parseWall(input: string, now: Date = new Date()): Wall {
  const raw = input.trim();
  if (!raw) throw new DateInputError("Empty date.");
  const s = raw.toLowerCase();

  const rel = s.match(/^([+-])(\d+)\s*(m|min|h|d|w)$/);
  if (rel) {
    const n = Number(rel[2]) * (rel[1] === "-" ? -1 : 1);
    const unitMs = { m: 60e3, min: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[rel[3] as "m"];
    const t = new Date(now.getTime() + n * unitMs);
    return wallFromDate(t, rel[3] === "m" || rel[3] === "min" || rel[3] === "h");
  }

  const words: Record<string, number> = {
    today: 0, tomorrow: 1, yesterday: -1, "今天": 0, "明天": 1, "后天": 2, "昨天": -1, "大后天": 3,
  };
  const wordMatch = s.match(/^(today|tomorrow|yesterday|今天|明天|后天|大后天|昨天)(?:\s*(?:at\s*)?(\d{1,2})(?::|：|点)?(\d{2})?分?)?$/);
  if (wordMatch) {
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + words[wordMatch[1]]);
    const w = wallFromDate(base, false);
    if (wordMatch[2] !== undefined) {
      w.H = Number(wordMatch[2]);
      w.M = wordMatch[3] ? Number(wordMatch[3]) : 0;
      if (w.H > 23 || w.M > 59) throw new DateInputError(`Invalid time in "${input}".`);
    }
    return w;
  }

  // Offset-aware ISO: convert to local wall time.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw) && raw.includes("T")) {
    const t = new Date(raw);
    if (Number.isNaN(t.getTime())) throw new DateInputError(`Could not read the date "${input}".`);
    return wallFromDate(t, true);
  }

  const m = raw.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2})[:：](\d{2})(?::\d{2}(?:\.\d+)?)?)?$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validDay(y, mo, d)) throw new DateInputError(`"${input}" is not a real calendar date.`);
    const w: Wall = { y, m: mo, d };
    if (m[4] !== undefined) {
      w.H = Number(m[4]);
      w.M = Number(m[5]);
      if (w.H > 23 || w.M > 59) throw new DateInputError(`Invalid time in "${input}".`);
    }
    return w;
  }
  throw new DateInputError(
    `Could not read the date "${input}". Use YYYY-MM-DD, YYYY-MM-DD HH:MM, an ISO timestamp, or today/tomorrow.`,
  );
}

/** Like parseWall but always returns a time (00:00 when only a day was given). */
export function parseMoment(input: string, now?: Date): Wall {
  const w = parseWall(input, now);
  if (w.H === undefined) {
    w.H = 0;
    w.M = 0;
  }
  return w;
}

export type AlarmSpec = { relative_minutes: number } | { at: Wall };

/**
 * Alarm strings:
 *   "-2d", "-1h", "-30m", "-1w"  relative to the due date / event start
 *   "0" or "at due"              exactly at the due time
 *   "2026-10-18 09:00"           an absolute time
 */
export function parseAlarm(input: string, now?: Date): AlarmSpec {
  const s = input.trim().toLowerCase();
  if (s === "0" || s === "at due" || s === "at start" || s === "on time") return { relative_minutes: 0 };
  const rel = s.match(/^([+-]?)(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hours?|d|days?|w|weeks?)(\s*before)?$/);
  if (rel) {
    const n = Number(rel[2]);
    const u = rel[3][0];
    const mins = n * ({ m: 1, h: 60, d: 1440, w: 10080 } as Record<string, number>)[u];
    const before = rel[1] === "-" || Boolean(rel[4]) || rel[1] === "";
    return { relative_minutes: Math.round(before ? -mins : mins) };
  }
  return { at: parseMoment(input, now) };
}

export function describeAlarm(a: { relative_minutes?: number; at?: string }): string {
  if (a.at) return `at ${formatIso(a.at)}`;
  const m = a.relative_minutes ?? 0;
  if (m === 0) return "at due time";
  const abs = Math.abs(m);
  const unit = abs % 10080 === 0 ? [abs / 10080, "w"] : abs % 1440 === 0 ? [abs / 1440, "d"] : abs % 60 === 0 ? [abs / 60, "h"] : [abs, "m"];
  return `${unit[0]}${unit[1]} ${m < 0 ? "before" : "after"}`;
}

/** "2026-10-20T09:00:00+08:00" -> "2026-10-20 09:00" in the Mac's local time. */
export function formatIso(iso: string | null | undefined, opts: { dateOnly?: boolean } = {}): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const day = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  return opts.dateOnly ? day : `${day} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function weekday(d: Date): string {
  return WEEKDAYS[d.getDay()];
}

export const WEEKDAY_NUMBERS: Record<string, number> = {
  sun: 1, sunday: 1, mon: 2, monday: 2, tue: 3, tuesday: 3, wed: 4, wednesday: 4,
  thu: 5, thursday: 5, fri: 6, friday: 6, sat: 7, saturday: 7,
};

export function startOfToday(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
}

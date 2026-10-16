import type { CallToolResult } from "@modelcontextprotocol/server";

export const CHARACTER_LIMIT = 25_000;

export function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

export function fail(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

/**
 * Content that came from outside the person's own instructions (email bodies,
 * message text, note contents) is fenced so the model treats it as data.
 */
export function untrusted(source: string, body: string): string {
  const clean = body.replace(/<\/?untrusted_content[^>]*>/gi, "");
  return `<untrusted_content source="${source}">\n${clean}\n</untrusted_content>`;
}

export function clip(s: string, max: number): { text: string; clipped: boolean } {
  if (s.length <= max) return { text: s, clipped: false };
  return { text: s.slice(0, max), clipped: true };
}

export function oneLine(s: unknown, max = 140): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Render a list page and shrink it until it fits under CHARACTER_LIMIT. */
export function fitPage<T>(items: T[], render: (items: T[]) => string): { text: string; shown: number } {
  let shown = items;
  let out = render(shown);
  while (shown.length > 1 && out.length > CHARACTER_LIMIT) {
    shown = shown.slice(0, Math.ceil(shown.length / 2));
    out = render(shown);
  }
  return { text: out, shown: shown.length };
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

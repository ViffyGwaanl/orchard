/**
 * Conversion between Markdown and the HTML dialect Apple Notes stores.
 * Notes keeps one <div> per line, uses <b>/<i>/<u>/<strike>/<tt>, real <ul>/<ol>
 * lists and <h1>-<h3> headings. Checklists cannot be created through scripting,
 * so Markdown task items become ☐ / ☑ lines.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(md: string): string {
  // Protect code spans first.
  const codes: string[] = [];
  let s = md.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, url: string) => `<a href="${url}">${alt || url}</a>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, url: string) => `<a href="${url}">${text}</a>`);
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<b><i>$1</i></b>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_]+)__/g, "<b>$1</b>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^\w_])_([^_\s][^_]*)_(?!\w)/g, "$1<i>$2</i>");
  s = s.replace(/~~([^~]+)~~/g, "<strike>$1</strike>");
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre: string, url: string) => `${pre}<a href="${url}">${url}</a>`);
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<tt>${escapeHtml(codes[Number(i)])}</tt>`);
  return s;
}

export function markdownToNotesHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let list: { type: "ul" | "ol"; indent: number }[] = [];
  let inCode = false;

  const closeLists = (toIndent = -1) => {
    while (list.length && list[list.length - 1].indent > toIndent) out.push(`</${list.pop()!.type}>`);
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      closeLists();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`<div><tt>${escapeHtml(line) || "&nbsp;"}</tt></div>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      const level = Math.min(3, h[1].length);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      closeLists();
      out.push(`<div>${task[2] === " " ? "☐" : "☑"} ${inline(task[3])}</div>`);
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const indent = li[1].replace(/\t/g, "  ").length;
      const type: "ul" | "ol" = /\d/.test(li[2]) ? "ol" : "ul";
      const top = list[list.length - 1];
      if (!top || indent > top.indent) {
        list.push({ type, indent });
        out.push(`<${type}>`);
      } else {
        closeLists(indent);
        const cur = list[list.length - 1];
        if (!cur) {
          list.push({ type, indent });
          out.push(`<${type}>`);
        } else if (cur.type !== type) {
          out.push(`</${list.pop()!.type}>`);
          list.push({ type, indent });
          out.push(`<${type}>`);
        }
      }
      out.push(`<li>${inline(li[3])}</li>`);
      continue;
    }
    closeLists();
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<div>────────────</div>");
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push(`<div><i>${inline(quote[1]) || "&nbsp;"}</i></div>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      if (/^\|[\s:|-]+\|\s*$/.test(line)) continue; // table separator row
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      out.push(`<div>${cells.join(" · ")}</div>`);
      continue;
    }
    out.push(line.trim() === "" ? "<div><br></div>" : `<div>${inline(line)}</div>`);
  }
  closeLists();
  return out.join("");
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function notesHtmlToMarkdown(html: string): string {
  let s = html.replace(/\r?\n/g, "");
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Tables -> pipe rows.
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, body: string) => {
    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
    );
    if (!rows.length) return "";
    const head = `| ${rows[0].join(" | ")} |`;
    const sep = `| ${rows[0].map(() => "---").join(" | ")} |`;
    const rest = rows.slice(1).map((r) => `| ${r.join(" | ")} |`);
    return `\n${[head, sep, ...rest].join("\n")}\n`;
  });
  // Notes wraps list item text in <div>s and marks code with a monospace font.
  s = s.replace(/<li([^>]*)>\s*<div[^>]*>([\s\S]*?)<\/div>\s*<\/li>/gi, "<li$1>$2</li>");
  s = s.replace(/<span[^>]*font-family:[^>]*(?:Menlo|Courier|Monaco|monospace)[^>]*>([\s\S]*?)<\/span>/gi, "<tt>$1</tt>");
  // Larger font sizes are how Notes stores Title/Heading/Subheading styles.
  s = s.replace(/<span[^>]*font-size:\s*(\d+)px[^>]*>([\s\S]*?)<\/span>/gi, (_, px: string, t: string) => {
    const n = Number(px);
    const h = n >= 22 ? "# " : n >= 18 ? "## " : n >= 15 ? "### " : "";
    return h ? `\u0001${h}${t}` : t;
  });
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  // Lists with nesting depth.
  let depth = 0;
  const ordered: boolean[] = [];
  const counters: number[] = [];
  s = s.replace(/<(\/?)(ul|ol|li)[^>]*>/gi, (_, close: string, tag: string) => {
    const t = tag.toLowerCase();
    if (t === "ul" || t === "ol") {
      if (close) {
        depth = Math.max(0, depth - 1);
        ordered.pop();
        counters.pop();
        return depth === 0 ? "\n" : "";
      }
      depth += 1;
      ordered.push(t === "ol");
      counters.push(0);
      return "";
    }
    if (close) return "";
    const isOl = ordered[ordered.length - 1];
    if (isOl) counters[counters.length - 1] += 1;
    const bullet = isOl ? `${counters[counters.length - 1]}.` : "-";
    return `\n${"  ".repeat(Math.max(0, depth - 1))}${bullet} `;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(div|p)>/gi, "\n").replace(/<(div|p)[^>]*>/gi, "");
  const wrap = (mark: string) => (_: string, __: string, t: string) => {
    const m = t.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    if (!m[2]) return t;
    // Keep line breaks outside the markers so headings and lists stay intact.
    return m[2].split("\n").map((line, i, all) => {
      const pre = i === 0 ? m[1] : "";
      const post = i === all.length - 1 ? m[3] : "";
      return line.trim() ? `${pre}${mark}${line.trim()}${mark}${post}` : `${pre}${post}`;
    }).join("\n");
  };
  s = s.replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, wrap("**"));
  s = s.replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi, wrap("*"));
  s = s.replace(/<(strike|s|del)[^>]*>([\s\S]*?)<\/\1>/gi, "~~$2~~");
  s = s.replace(/<tt[^>]*>([\s\S]*?)<\/tt>/gi, "`$1`");
  s = s.replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url: string, text: string) => {
    const t = text.replace(/<[^>]+>/g, "");
    return t === url ? url : `[${t}](${url})`;
  });
  s = s.replace(/<img[^>]*>/gi, "[image]");
  s = s.replace(/<object[^>]*>[\s\S]*?<\/object>/gi, "[attachment]");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\*\*\u0001(#{1,3} )([^\n]*?)\*\*/g, "$1$2").replace(/\u0001/g, "");
  s = s.replace(/\*\*\s*\*\*/g, "").replace(/^\*{1,2}$/gm, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  // Consecutive list items should not be separated by blank lines.
  for (let i = 0; i < 2; i++) s = s.replace(/^([ \t]*(?:[-*]|\d+\.) .*)\n\n(?=[ \t]*(?:[-*]|\d+\.) )/gm, "$1\n");
  return s.trim();
}

/** Plain text for previews. */
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|p|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

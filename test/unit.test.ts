import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseWall, parseAlarm, describeAlarm, DateInputError } from "../src/lib/dates.ts";
import { markdownToNotesHtml, notesHtmlToMarkdown } from "../src/lib/markdown.ts";
import { alarmsToHelper } from "../src/tools/common.ts";

const NOW = new Date(2026, 9, 16, 11, 30); // 2026-10-16 11:30 local

test("parseWall handles the formats people and models use", () => {
  assert.deepEqual(parseWall("2026-10-20", NOW), { y: 2026, m: 10, d: 20 });
  assert.deepEqual(parseWall("2026/10/20 09:05", NOW), { y: 2026, m: 10, d: 20, H: 9, M: 5 });
  assert.deepEqual(parseWall("2026-10-20T18:30:00", NOW), { y: 2026, m: 10, d: 20, H: 18, M: 30 });
  assert.deepEqual(parseWall("2026年10月20日", NOW), { y: 2026, m: 10, d: 20 });
  assert.deepEqual(parseWall("tomorrow", NOW), { y: 2026, m: 10, d: 17 });
  assert.deepEqual(parseWall("明天 9:00", NOW), { y: 2026, m: 10, d: 17, H: 9, M: 0 });
  assert.deepEqual(parseWall("后天", NOW), { y: 2026, m: 10, d: 18 });
  assert.deepEqual(parseWall("today 18:00", NOW), { y: 2026, m: 10, d: 16, H: 18, M: 0 });
  assert.deepEqual(parseWall("+3d", NOW), { y: 2026, m: 10, d: 19 });
  assert.deepEqual(parseWall("-2h", NOW), { y: 2026, m: 10, d: 16, H: 9, M: 30 });
  const z = parseWall("2026-10-20T01:00:00Z", NOW);
  const expect = new Date(Date.UTC(2026, 9, 20, 1, 0));
  assert.deepEqual(z, { y: expect.getFullYear(), m: expect.getMonth() + 1, d: expect.getDate(), H: expect.getHours(), M: expect.getMinutes() });
  assert.throws(() => parseWall("2026-02-30", NOW), DateInputError);
  assert.throws(() => parseWall("next blue moon", NOW), DateInputError);
  assert.throws(() => parseWall("2026-10-20 25:00", NOW), DateInputError);
});

test("alarms: relative, absolute and all-day anchoring", () => {
  assert.deepEqual(parseAlarm("-2d"), { relative_minutes: -2880 });
  assert.deepEqual(parseAlarm("2 days before"), { relative_minutes: -2880 });
  assert.deepEqual(parseAlarm("-30m"), { relative_minutes: -30 });
  assert.deepEqual(parseAlarm("0"), { relative_minutes: 0 });
  assert.deepEqual(parseAlarm("2026-10-18 09:00", NOW), { at: { y: 2026, m: 10, d: 18, H: 9, M: 0 } });
  // All-day due: fire at 09:00 two days earlier
  assert.deepEqual(alarmsToHelper(["-2d"], { y: 2026, m: 10, d: 22 }, NOW), [{ at: { y: 2026, m: 10, d: 20, H: 9, M: 0 } }]);
  // Timed due: stay relative
  assert.deepEqual(alarmsToHelper(["-1h"], { y: 2026, m: 10, d: 22, H: 15, M: 0 }, NOW), [{ relative_minutes: -60 }]);
  assert.equal(describeAlarm({ relative_minutes: -2880 }), "2d before");
  assert.equal(describeAlarm({ relative_minutes: -90 }), "90m before");
});

test("markdown round-trips through Notes HTML", () => {
  const md = "# Title\n\nSome **bold**, *italic*, `code` and [a link](https://x.y).\n\n- one\n- two\n  - nested\n1. first\n2. second\n- [ ] todo\n- [x] done\n\n> quoted";
  const html = markdownToNotesHtml(md);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /<i>italic<\/i>/);
  assert.match(html, /<tt>code<\/tt>/);
  assert.match(html, /<a href="https:\/\/x.y">a link<\/a>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><ul><li>nested<\/li><\/ul><\/ul><ol><li>first/);
  assert.match(html, /☐ todo/);
  assert.match(html, /☑ done/);
  const back = notesHtmlToMarkdown(html);
  assert.match(back, /^# Title/);
  assert.match(back, /\*\*bold\*\*/);
  assert.match(back, /- one\n- two\n  - nested/);
  assert.match(back, /1\. first\n2\. second/);
  assert.match(back, /\[a link\]\(https:\/\/x.y\)/);
});

test("markdown escapes HTML so notes cannot be injected with markup", () => {
  const html = markdownToNotesHtml("<script>alert(1)</script> & <b>x</b>");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test("Notes HTML with tables, entities and images converts cleanly", () => {
  const md = notesHtmlToMarkdown('<div>A&nbsp;&amp;&nbsp;B</div><table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table><div><img src="x"></div>');
  assert.match(md, /A & B/);
  assert.match(md, /\| a \| b \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  assert.match(md, /\[image\]/);
});

test("real-world Notes HTML: styled headings, wrapped list items, monospace", () => {
  const html =
    '<div><b><span style="font-size: 24px">Orchard 测试</span></b><br></div>' +
    '<div><b><span style="font-size: 18px">今日要点</span></b><br></div>' +
    "<div>☐ 支付租金</div>" +
    '<ul><li><div><b>加粗</b> 和 <a href="https://example.com/">链接</a></div></li><li><div>第二</div></li></ul>' +
    "<ol><li><div>第一项</div></li><li><div>第二项</div></li></ol>" +
    '<div>带 <span style="font-family: Menlo-Regular">代码</span></div><div><b><br></b></div>';
  const md = notesHtmlToMarkdown(html);
  assert.match(md, /^# Orchard 测试$/m);
  assert.match(md, /^## 今日要点$/m);
  assert.match(md, /- \*\*加粗\*\* 和 \[链接\]\(https:\/\/example.com\/\)\n- 第二/);
  assert.match(md, /1\. 第一项\n2\. 第二项/);
  assert.match(md, /带 `代码`/);
  assert.doesNotMatch(md, /^\*\*$/m);
});

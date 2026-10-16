/**
 * End-to-end self-check: starts the built server against the fake helper,
 * calls every tool the way Claude would, and checks the answers.
 * Run: npm run build && npm run smoke   (FAKE_FDA=0 simulates no Full Disk Access)
 */
import { strict as assert } from "node:assert";
import { chmodSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const fake = new URL("../test/fake-helper.mjs", import.meta.url).pathname;
chmodSync(fake, 0o755);
const client = new Client({ name: "orchard-smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: [new URL("../dist/index.js", import.meta.url).pathname],
  env: { ...getDefaultEnvironment(), ORCHARD_HELPER: fake, FAKE_FDA: process.env.FAKE_FDA ?? "1", TZ: process.env.TZ ?? "Asia/Shanghai" },
}));

const transcript = [];
async function t(name, args = {}, expectError = false) {
  if (process.env.SMOKE_VERBOSE) console.error(`→ ${name}`);
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
  const out = r.content.map((c) => c.text).join("\n");
  transcript.push(`### ${name} ${JSON.stringify(args)}\n${r.isError ? "[isError]\n" : ""}${out}\n`);
  if (expectError) assert.equal(r.isError, true, `${name} should fail: ${out}`);
  else assert.ok(!r.isError, `${name} failed: ${out}`);
  return out;
}

const { tools } = await client.listTools();
const names = tools.map((x) => x.name).sort();
console.error(`${names.length} tools: ${names.join(", ")}`);
for (const tool of tools) {
  assert.ok(tool.description && tool.description.length > 30, `${tool.name} needs a description`);
  assert.ok(tool.annotations, `${tool.name} needs annotations`);
}
const { prompts } = await client.listPrompts();
assert.deepEqual(prompts.map((p) => p.name).sort(), ["plan_my_day", "weekly_review"]);

const fda = (process.env.FAKE_FDA ?? "1") !== "0";

// System
let out = await t("apple_status");
assert.match(out, /Reminders — allowed/);
assert.match(out, /To finish setup/);
out = await t("apple_grant_access", { areas: ["contacts", "Notes"] });
assert.match(out, /✅ contacts/);

// Today
out = await t("apple_today");
assert.match(out, /Team standup|Lunch with Li Wei/);
assert.match(out, /Pay office rent/);
if (fda) assert.match(out, /Fotor brief v2/);
if (fda) assert.match(out, /<untrusted_content source="messages">/);

// Search everything
out = await t("apple_search", { query: "Fotor" });
assert.match(out, /## Reminders/);
assert.match(out, /Reply to Fotor brief/);
assert.match(out, /## Calendar[\s\S]*Fotor publish day/);
if (fda) assert.match(out, /Fotor brief v2/);
assert.match(out, /## Notes\nFull-text search needs Full Disk Access/);
out = await t("apple_search", { query: "zzzz-nothing" });
assert.match(out, /Nothing on this Mac mentions/);

// Mail triage tools degrade gracefully without the index (fake helper has no real Mail store)
out = await t("mail_senders", {}, true);
assert.match(out, /Full Disk Access/);

// Reminders
await t("reminders_list_lists");
out = await t("reminders_find", { when: "today_and_overdue" });
assert.match(out, /Pay office rent/);
assert.match(out, /overdue/);
out = await t("reminders_create", { items: [
  { title: "支付李梅芳的报销款", due: "today", list: "Work" },
  { title: "发布 Kimi 商单", due: "2026-10-15", alarms: ["-2d"], priority: "high", notes: "宣发计划调整" },
  { title: "Water plants", due: "tomorrow 08:00", repeat: { frequency: "weekly", days_of_week: ["mon", "thu"] } },
  { title: "Broken", list: "Nope" },
] });
assert.match(out, /Created 3 reminders/);
assert.match(out, /Failed 1/);
assert.match(out, /alerts: at 2026-10-13 09:00/, "relative alarm on all-day item should fire at 09:00 two days before");
assert.match(out, /repeats every week on Mon\/Thu/);
const kimiId = out.match(/发布 Kimi 商单.*`(R\d+)`/)[1];
out = await t("reminders_update", { id: kimiId, alarms: ["-1d", "-3d"] });
assert.match(out, /alerts: at 2026-10-14 09:00, at 2026-10-12 09:00/);
out = await t("reminders_update", { id: kimiId, due: null });
assert.doesNotMatch(out, /due /);
await t("reminders_update", { id: kimiId }, true);
out = await t("reminders_complete", { ids: [kimiId] });
assert.match(out, /Completed 1/);
out = await t("reminders_find", { status: "completed" });
assert.match(out, /\[x\] \*\*发布 Kimi 商单/);
out = await t("reminders_find", { when: "no_date" });
assert.match(out, /Buy SSD enclosure/);
out = await t("reminders_delete", { ids: [kimiId, "R999"] });
assert.match(out, /Deleted 1/);
await t("reminders_manage_list", { action: "create", name: "Errands" });
await t("reminders_create", { items: [{ title: "x", alarms: ["-1d"] }] }, true);
await t("reminders_create", { items: [{ title: "y", due: "2026-02-30" }] }, true);

// Calendar
await t("calendar_list_calendars");
out = await t("calendar_find_events", { from: "today", to: "tomorrow" });
assert.match(out, /Team standup/);
assert.match(out, /Fotor publish day/);
out = await t("calendar_create_event", { title: "Dentist", start: "2026-10-20 15:00", alarms: ["-1h"], location: "Zhujiang New Town" });
assert.match(out, /15:00–16:00/);
const evId = out.match(/`(E\d+)`/)[1];
out = await t("calendar_update_event", { id: evId, start: "2026-10-21 10:00" });
assert.match(out, /10:00–11:00/);
out = await t("calendar_delete_event", { id: evId });
assert.match(out, /Deleted "Dentist"/);

// Contacts
out = await t("contacts_search", { query: "李" });
assert.match(out, /李梅芳/);

// Notes (real JXA scripts against the mock object model)
out = await t("notes_list_folders");
assert.match(out, /Work\/\*\*Meetings|\*\*Work\/Meetings\*\*/);
out = await t("notes_list", { limit: 10 });
assert.match(out, /Fotor ideas/);
assert.match(out, /🔒/);
out = await t("notes_search", { query: "4K" });
assert.match(out, /Searched titles only/, "without the database, body search falls back to titles");
out = await t("notes_search", { query: "Standup" });
assert.match(out, /Standup 10\/15/);
const shopId = (await t("notes_search", { query: "Shopping", titles_only: true })).match(/`(x-coredata[^`]+)`/)[1];
out = await t("notes_read", { id: shopId });
assert.match(out, /- Eggs/);
assert.doesNotMatch(out.split("\n\n").slice(1).join("\n"), /^# Shopping/m);
out = await t("notes_create", { title: "Orchard 测试", body: "## 待办\n- [ ] 买菜\n- **加粗** 和 [链接](https://example.com)\n\n1. one\n2. two", folder: "Work" });
const newNote = out.match(/`(x-coredata[^`]+)`/)[1];
out = await t("notes_read", { id: newNote });
assert.match(out, /☐ 买菜/);
assert.match(out, /\*\*加粗\*\*/);
assert.match(out, /\[链接\]\(https:\/\/example.com\)/);
assert.match(out, /1\. one/);
await t("notes_update", { id: newNote, body: "追加一行" });
out = await t("notes_read", { id: newNote });
assert.match(out, /追加一行/);
await t("notes_update", { id: newNote, body: "全新内容", mode: "replace", title: "改名了" });
out = await t("notes_read", { id: newNote });
assert.match(out, /^# 改名了/);
assert.doesNotMatch(out, /追加一行/);
const fotorId = (await t("notes_search", { query: "Fotor ideas" })).match(/`(x-coredata[^`]+)`/)[1];
out = await t("notes_update", { id: fotorId, body: "x" }, true);
assert.match(out, /attachment/);
out = await t("notes_move", { id: newNote, folder: "Meetings" });
assert.match(out, /Meetings/);
await t("notes_create", { title: "x", folder: "Nope" }, true);
out = await t("notes_delete", { id: newNote });
assert.match(out, /Recently Deleted/);

// Mail
out = await t("mail_list_accounts");
assert.match(out, /Gmail/);
out = await t("mail_search", { unread_only: true });
assert.match(out, /Fotor brief v2/);
assert.match(out, /<untrusted_content source="mail">/);
if (!fda) assert.match(out, /Grant Full Disk Access/);
out = await t("mail_read", { id: 501 });
assert.match(out, /Please see the new brief/);
assert.match(out, /brief\.pdf/);
out = await t("mail_compose", { to: ["Li Wei <liwei@example.com>"], subject: "Hello", body: "Draft body" });
assert.match(out, /Opened a draft/);
out = await t("mail_compose", { reply_to_id: 501, body: "收到，谢谢", send_now: true });
assert.match(out, /Sent "Re: Fotor brief v2" to team@fotor.test/);
await t("mail_compose", { to: ["not-an-address"], body: "x" }, true);
out = await t("mail_update", { ids: [502], action: "move", mailbox: "Archive" });
assert.match(out, /Moved to Archive: 1/);
out = await t("mail_update", { ids: [501], action: "flag" });
assert.match(out, /Flagged: 1/);

// Messages
if (fda) {
  out = await t("messages_list_chats", { unread_only: true });
  assert.match(out, /Mom/);
  out = await t("messages_read", { with: "Mom" });
  assert.match(out, /晚上回来吃饭吗/);
  assert.match(out, /<untrusted_content source="messages">/);
  out = await t("messages_search", { query: "Fotor" });
  assert.match(out, /10\.22/);
  out = await t("messages_send", { to: "Mom", text: "今晚回来吃" });
  assert.match(out, /Message to Mom: sent/);
  out = await t("messages_send", { chat_id: 2, text: "收到" });
  assert.match(out, /虚实传媒群: sent/);
  out = await t("messages_send", { to: "Li Wei", text: "hi" }, true);
  assert.match(out, /several numbers/);
  out = await t("messages_send", { to: "Nobody Here", text: "hi" }, true);
} else {
  out = await t("messages_list_chats", {}, true);
  assert.match(out, /FULL_DISK_ACCESS_REQUIRED/);
  assert.match(out, /apple_open_settings/);
}

writeFileSync(new URL(`../test/smoke-transcript${fda ? "" : "-nofda"}.md`, import.meta.url), transcript.join("\n"));
await client.close();
console.error(`Smoke test passed (${fda ? "with" : "without"} Full Disk Access): ${transcript.length} calls`);

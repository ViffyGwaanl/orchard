import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIL_FILE_PYTHON } from "../src/jxa/mailfile.ts";

const home = mkdtempSync(join(tmpdir(), "mailhome-"));
const acct = "D90655D5-948A-4407-9A7B-CCC8B5860743";

function emlx(dir: string, name: string, rfc822: Buffer) {
  mkdirSync(dir, { recursive: true });
  const plist = Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict><key>flags</key><integer>8590195713</integer></dict></plist>\n');
  writeFileSync(join(dir, name), Buffer.concat([Buffer.from(`${rfc822.length}\n`), rfc822, plist]));
}

// 58968 -> 58968 // 1000 = 58 -> digits reversed -> Data/8/5/Messages
const gbBody = Buffer.from("5L2g5aW977yM6L+Z5piv5LiA5bCB5rWL6K+V6YKu5Lu244CC", "base64"); // UTF-8 bytes of a Chinese sentence
const multipart = Buffer.concat([
  Buffer.from(
    "From: =?UTF-8?B?5LiW55WM5Lq65bel5pm66IO95aSn5Lya?= <waic@example.com>\r\n" +
      "To: me@example.com\r\nCc: boss@example.com\r\nSubject: =?UTF-8?B?5Y2z5Yi75oql5ZCN?=\r\n" +
      "Date: Fri, 16 Oct 2026 04:45:00 -0400\r\nMessage-ID: <x1@example.com>\r\nMIME-Version: 1.0\r\n" +
      'Content-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: multipart/alternative; boundary="A"\r\n\r\n' +
      "--A\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n",
  ),
  Buffer.from(Buffer.from(`<p>${gbBody.toString("utf8")}</p><p>See <a href="https://waic.example">site</a></p>`).toString("base64") + "\r\n"),
  Buffer.from(
    "--A--\r\n--B\r\nContent-Type: application/pdf; name=\"agenda.pdf\"\r\nContent-Disposition: attachment; filename=\"agenda.pdf\"\r\n" +
      "Content-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--B--\r\n",
  ),
]);
emlx(join(home, "Library/Mail/V10", acct, "INBOX.mbox/STORE-UUID/Data/8/5/Messages"), "58968.emlx", multipart);

// A GBK-encoded plain message inside a Gmail-style nested mailbox, under 1000
const gbk = Buffer.concat([
  Buffer.from("From: a@b.cn\r\nTo: me@example.com\r\nSubject: =?GBK?B?suLK1A==?=\r\nContent-Type: text/plain; charset=GBK\r\n\r\n"),
  Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), // "你好" in GBK
]);
emlx(join(home, "Library/Mail/V10", acct, "[Gmail].mbox/All Mail.mbox/S2/Data/Messages"), "42.partial.emlx", gbk);

const run = (args: object) =>
  JSON.parse(execFileSync("python3", ["-c", MAIL_FILE_PYTHON, JSON.stringify(args)], { encoding: "utf8", env: { ...process.env, HOME: home } }));

test("reads an .emlx via the id-based folder layout, decoding MIME, HTML and attachments", () => {
  const r = run({ id: 58968, account_id: acct, mailbox: "INBOX" });
  assert.equal(r.subject, "即刻报名");
  assert.match(r.from, /世界人工智能大会/);
  assert.deepEqual(r.cc, ["boss@example.com"]);
  assert.match(r.content, /你好，这是一封测试邮件。/);
  assert.match(r.content, /site \(https:\/\/waic.example\)/);
  assert.deepEqual(r.attachments.map((x: { name: string }) => x.name), ["agenda.pdf"]);
  assert.equal(r.partial, false);
});

test("finds messages in nested mailboxes and partial downloads, with GBK text", () => {
  const direct = run({ id: 42, account_id: acct, mailbox: "[Gmail]/All Mail" });
  assert.equal(direct.subject, "测试");
  assert.equal(direct.content.trim(), "你好");
  assert.equal(direct.partial, true);
  const walked = run({ id: 42, account_id: acct, mailbox: "wrong name" });
  assert.equal(walked.subject, "测试", "falls back to walking the account's mailboxes");
});

test("unknown ids report NOT_FOUND", () => {
  assert.equal(run({ id: 99999, account_id: acct, mailbox: "INBOX" }).error, "NOT_FOUND");
});

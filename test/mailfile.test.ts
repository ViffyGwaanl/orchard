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

import { MAIL_SENDERS_PYTHON } from "../src/jxa/mailstats.ts";

test("sender statistics over the whole inbox, including Gmail's INBOX label", () => {
  const dir = join(home, "Library/Mail/V10/MailData");
  mkdirSync(dir, { recursive: true });
  const sql = `
CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT, total_count INTEGER, unread_count INTEGER);
CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, sender INTEGER, subject INTEGER, summary INTEGER, mailbox INTEGER, date_received INTEGER, read INTEGER, deleted INTEGER, flagged INTEGER);
CREATE TABLE labels (message_id INTEGER, mailbox_id INTEGER);
INSERT INTO addresses VALUES (1,'News@FC2.com','FC2 Content Market'),(2,'li@example.com','Li Wei'),(3,'bot@spam.test','Bot');
INSERT INTO mailboxes VALUES (1,'imap://${acct}/INBOX',10,5),(2,'imap://F9CA2CAD-BB55-4704-BA12-400CA8219572/%5BGmail%5D/All%20Mail',10,5),(3,'imap://F9CA2CAD-BB55-4704-BA12-400CA8219572/INBOX',0,0),(4,'imap://${acct}/Archive',1,1);
INSERT INTO messages VALUES (1,1,0,0,1,1792000000,0,0,0),(2,1,0,0,1,1792000100,0,0,0),(3,1,0,0,2,1792000200,0,0,0),(4,2,0,0,1,1792000300,0,0,0),(5,2,0,0,1,1792000400,1,0,0),(6,3,0,0,4,1792000500,0,0,0),(7,3,0,0,1,1792000600,0,1,0);
INSERT INTO labels VALUES (3,3);`;
  execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.commit()", join(dir, "Envelope Index"), sql]);
  const r = JSON.parse(execFileSync("python3", ["-c", MAIL_SENDERS_PYTHON, JSON.stringify({ unread_only: true })], { encoding: "utf8", env: { ...process.env, HOME: home } }));
  assert.equal(r.total, 4, "archived, read and deleted mail is excluded");
  assert.deepEqual(r.senders.map((x: { address: string; count: number }) => [x.address, x.count]), [["news@fc2.com", 3], ["li@example.com", 1]]);
  assert.deepEqual(r.senders[0].accounts.sort(), [acct, "F9CA2CAD-BB55-4704-BA12-400CA8219572"].sort());
  const only = JSON.parse(execFileSync("python3", ["-c", MAIL_SENDERS_PYTHON, JSON.stringify({ from: "fc2" })], { encoding: "utf8", env: { ...process.env, HOME: home } }));
  assert.equal(only.total, 3);
});

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTES_DB, NOTES_DB_PYTHON } from "../src/jxa/notesdb.ts";
// @ts-expect-error plain JS test helper
import { runJxa } from "./jxa-mock.mjs";

const dir = mkdtempSync(join(tmpdir(), "notestore-"));
const db = join(dir, "NoteStore's copy.sqlite"); // a quote and spaces to exercise escaping
execFileSync("python3", ["test/make-notestore.py", db]);
const py = (args: object) => JSON.parse(execFileSync("python3", ["-c", NOTES_DB_PYTHON, JSON.stringify({ db, ...args })], { encoding: "utf8" }));

test("lists notes newest first, skipping trash and deleted ones", () => {
  const r = py({ limit: 10 });
  assert.equal(r.total, 3);
  assert.deepEqual(r.items.map((n: { name: string }) => n.name), ["Shopping", "会议纪要 10/15", "Secret"]);
  assert.equal(r.items[0].id, "x-coredata://E0423D34-TEST/ICNote/p100");
  assert.equal(r.items[0].folder, "iCloud/Notes");
  assert.equal(r.items[2].locked, true);
  assert.match(r.items[0].modified, /^2026-10-/);
});

test("full-text search decodes gzip protobuf bodies (any language)", () => {
  const r = py({ query: "fotor" });
  assert.equal(r.total, 1);
  assert.equal(r.items[0].name, "会议纪要 10/15");
  assert.match(r.items[0].snippet, /Fotor 档期改到 10\.22/);
  assert.equal(py({ query: "eggs" }).items[0].name, "Shopping");
  assert.equal(py({ query: "eggs", titles_only: true }).total, 0);
  assert.equal(py({ query: "cipher" }).total, 0, "locked note bodies are never searched");
});

test("folder filter and paging", () => {
  assert.equal(py({ folder: "提示词" }).total, 1);
  assert.equal(py({ folder: "iCloud/Notes" }).total, 2);
  const p = py({ limit: 1, offset: 1 });
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].name, "会议纪要 10/15");
});

test("missing database reports NO_DB / NO_ACCESS instead of crashing", () => {
  assert.equal(py({ db: join(dir, "nope.sqlite") }).error, "NO_DB");
});

test("the JXA wrapper quotes the script and arguments safely for the shell", () => {
  const out = runJxa(NOTES_DB, {}, [JSON.stringify({ db, query: "4K" })]);
  const r = JSON.parse(out);
  assert.equal(r.total, 1);
  assert.equal(r.via, "database");
});

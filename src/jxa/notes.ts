/**
 * JXA programs for Apple Notes. Each is run by `osascript -l JavaScript` inside
 * the helper; arguments arrive as one JSON string and results leave as JSON.
 * Failures are returned as {error, ...} instead of thrown, so the caller can
 * explain them precisely.
 */

const PRELUDE = String.raw`
const Notes = Application('Notes');
function allFolders() {
  const seen = {};
  Notes.accounts().forEach(function (acc) {
    const accName = acc.name();
    const walk = function (fs, prefix) {
      fs.forEach(function (f) {
        let id; try { id = f.id(); } catch (e) { return; }
        const name = f.name();
        const path = prefix ? prefix + '/' + name : name;
        if (!seen[id] || seen[id].path.length < path.length) seen[id] = { id: id, name: name, path: path, account: accName, ref: f };
        let subs = []; try { subs = f.folders(); } catch (e) {}
        if (subs.length) walk(subs, path);
      });
    };
    walk(acc.folders(), '');
  });
  return Object.keys(seen).map(function (k) { return seen[k]; });
}
function findFolder(spec) {
  const fs = allFolders();
  const s = String(spec).toLowerCase();
  let m = fs.filter(function (f) { return f.path.toLowerCase() === s || (f.account + '/' + f.path).toLowerCase() === s || f.id === spec; });
  if (!m.length) m = fs.filter(function (f) { return f.name.toLowerCase() === s; });
  if (!m.length) return { error: 'NO_FOLDER', folder: spec, available: fs.map(function (f) { return f.account + '/' + f.path; }) };
  return m[0];
}
function noteRef(id) {
  const n = Notes.notes.byId(id);
  try { n.name(); } catch (e) { return null; }
  return n;
}
function folderOf(n) { try { return n.container().name(); } catch (e) { return null; } }
function iso(d) { try { return d ? d.toISOString() : null; } catch (e) { return null; } }
`;

function program(body: string): string {
  return `${PRELUDE}\nfunction run(argv) {\n  const a = JSON.parse(argv[0] || '{}');\n${body}\n}`;
}

export const NOTES_FOLDERS = program(String.raw`
  const out = allFolders().map(function (f) {
    let count = null; try { count = f.ref.notes.length; } catch (e) {}
    return { id: f.id, name: f.name, path: f.path, account: f.account, count: count };
  });
  return JSON.stringify(out);
`);

const LIST_BODY = String.raw`
  const ids = coll.id(), names = coll.name(), mods = coll.modificationDate();
  const order = ids.map(function (_, i) { return i; }).sort(function (x, y) { return mods[y] - mods[x]; });
  const total = order.length;
  const page = order.slice(a.offset || 0, (a.offset || 0) + (a.limit || 20)).map(function (i) {
    const n = Notes.notes.byId(ids[i]);
    let text = ''; let locked = false;
    try { locked = n.passwordProtected(); } catch (e) {}
    if (!locked) { try { text = n.plaintext(); } catch (e) {} }
    let snippet = text.slice(0, 220);
    if (a.query) {
      const at = text.toLowerCase().indexOf(String(a.query).toLowerCase());
      if (at > 80) snippet = '…' + text.slice(at - 60, at + 160);
    }
    return { id: ids[i], name: names[i], modified: iso(mods[i]), folder: folderPath || folderOf(n), locked: locked, snippet: snippet };
  });
  return JSON.stringify({ total: total, items: page });
`;

export const NOTES_LIST = program(String.raw`
  let coll = Notes.notes, folderPath = null;
  if (a.folder) {
    const f = findFolder(a.folder);
    if (f.error) return JSON.stringify(f);
    coll = f.ref.notes; folderPath = f.account + '/' + f.path;
  }
${LIST_BODY}`);

export const NOTES_SEARCH = program(String.raw`
  const q = String(a.query);
  let base = Notes.notes, folderPath = null;
  if (a.folder) {
    const f = findFolder(a.folder);
    if (f.error) return JSON.stringify(f);
    base = f.ref.notes; folderPath = f.account + '/' + f.path;
  }
  const coll = a.titles_only
    ? base.whose({ name: { _contains: q } })
    : base.whose({ _or: [{ name: { _contains: q } }, { plaintext: { _contains: q } }] });
${LIST_BODY}`);

export const NOTES_READ = program(String.raw`
  const n = noteRef(a.id);
  if (!n) return JSON.stringify({ error: 'NOT_FOUND', id: a.id });
  let locked = false; try { locked = n.passwordProtected(); } catch (e) {}
  let atts = []; try { atts = n.attachments().map(function (x) { let nm = null; try { nm = x.name(); } catch (e) {} return nm; }); } catch (e) {}
  return JSON.stringify({
    id: a.id, name: n.name(), folder: folderOf(n), locked: locked,
    created: iso(n.creationDate()), modified: iso(n.modificationDate()),
    body: locked ? null : n.body(), attachments: atts
  });
`);

export const NOTES_CREATE = program(String.raw`
  let folder;
  if (a.folder) {
    const f = findFolder(a.folder);
    if (f.error) return JSON.stringify(f);
    folder = f.ref;
  } else {
    try { folder = Notes.defaultAccount().defaultFolder(); } catch (e) { folder = Notes.folders()[0]; }
  }
  let n;
  try {
    n = Notes.make({ new: 'note', at: folder, withProperties: { body: a.html } });
  } catch (e) {
    const note = Notes.Note({ body: a.html });
    folder.notes.push(note);
    n = note;
  }
  return JSON.stringify({ id: n.id(), name: n.name(), folder: folder.name() });
`);

export const NOTES_UPDATE = program(String.raw`
  const n = noteRef(a.id);
  if (!n) return JSON.stringify({ error: 'NOT_FOUND', id: a.id });
  if (n.passwordProtected()) return JSON.stringify({ error: 'LOCKED' });
  let atts = 0; try { atts = n.attachments().length; } catch (e) {}
  if (atts > 0 && !a.force) return JSON.stringify({ error: 'HAS_ATTACHMENTS', count: atts });
  const name = n.name();
  if (a.mode === 'append') {
    n.body = n.body() + a.html;
  } else if (a.mode === 'prepend') {
    const b = n.body();
    const cut = b.search(/<\/(div|h1|h2|h3|p)>/i);
    if (cut >= 0) {
      const end = b.indexOf('>', cut) + 1;
      n.body = b.slice(0, end) + a.html + b.slice(end);
    } else {
      n.body = a.html + b;
    }
  } else {
    n.body = (a.titleHtml || ('<div><h1>' + name.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</h1></div>')) + a.html;
  }
  return JSON.stringify({ id: a.id, name: n.name(), folder: folderOf(n), modified: iso(n.modificationDate()) });
`);

export const NOTES_MOVE = program(String.raw`
  const n = noteRef(a.id);
  if (!n) return JSON.stringify({ error: 'NOT_FOUND', id: a.id });
  const f = findFolder(a.folder);
  if (f.error) return JSON.stringify(f);
  const name = n.name();
  Notes.move(n, { to: f.ref });
  return JSON.stringify({ id: a.id, name: name, folder: f.account + '/' + f.path });
`);

export const NOTES_DELETE = program(String.raw`
  const n = noteRef(a.id);
  if (!n) return JSON.stringify({ error: 'NOT_FOUND', id: a.id });
  const name = n.name();
  Notes.delete(n);
  return JSON.stringify({ id: a.id, name: name });
`);

export const ALL_NOTES_SCRIPTS = { NOTES_FOLDERS, NOTES_LIST, NOTES_SEARCH, NOTES_READ, NOTES_CREATE, NOTES_UPDATE, NOTES_MOVE, NOTES_DELETE };

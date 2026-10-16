/**
 * Fast Notes listing and full-text search straight from Notes' own database.
 *
 * Asking Notes.app to search note bodies over Apple Events takes minutes on a
 * library of a few hundred notes. Reading NoteStore.sqlite takes milliseconds.
 * The database needs Full Disk Access, which belongs to Orchard Helper; this
 * script runs as osascript -> /bin/sh -> python3 under the helper, so the grant
 * applies without rebuilding the helper. Note bodies are gzip-compressed
 * protobuf; the parser below pulls out the plain text.
 */

const PY = String.raw`
import sqlite3, sys, json, zlib, os, datetime, urllib.parse, time
started = time.time()
partial = False
a = json.loads(sys.argv[1])
db = a.get('db') or os.path.expanduser('~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite')
def out(o):
    sys.stdout.write(json.dumps(o, ensure_ascii=False)); sys.exit(0)
if not os.path.exists(db):
    try:
        os.listdir(os.path.dirname(db))
        out({'error': 'NO_DB'})
    except Exception as e:
        out({'error': 'NO_ACCESS', 'detail': str(e)})
try:
    con = sqlite3.connect('file:' + urllib.parse.quote(db) + '?mode=ro', uri=True)
    cur = con.cursor()
    cur.execute('SELECT 1 FROM sqlite_master LIMIT 1')
except Exception as e:
    out({'error': 'NO_ACCESS', 'detail': str(e)})
def cols(t):
    return {r[1] for r in cur.execute('PRAGMA table_info(%s)' % t)}
C = cols('ZICCLOUDSYNCINGOBJECT')
def pick(*names):
    for n in names:
        if n in C: return n
    return None
ents = {name: ent for ent, name in cur.execute('SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY')}
note_ent = ents.get('ICNote')
store = cur.execute('SELECT Z_UUID FROM Z_METADATA').fetchone()[0]
title, snippet = pick('ZTITLE1', 'ZTITLE'), pick('ZSNIPPET')
mod, folder = pick('ZMODIFICATIONDATE1', 'ZMODIFICATIONDATE'), pick('ZFOLDER')
ftitle, owner, aname = pick('ZTITLE2', 'ZTITLE'), pick('ZOWNER', 'ZACCOUNT'), pick('ZNAME')
deleted, locked, ftype = pick('ZMARKEDFORDELETION'), pick('ZISPASSWORDPROTECTED'), pick('ZFOLDERTYPE')
notedata = pick('ZNOTEDATA')
def col(alias, c):
    return '%s.%s' % (alias, c) if c else 'NULL'
sql = 'SELECT n.Z_PK, %s, %s, %s, %s, %s, %s, %s, %s FROM ZICCLOUDSYNCINGOBJECT n ' \
      'LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = %s ' \
      'LEFT JOIN ZICCLOUDSYNCINGOBJECT ac ON ac.Z_PK = %s ' \
      'WHERE n.Z_ENT = ?' % (col('n', title), col('n', snippet), col('n', mod), col('n', locked), col('n', notedata),
                             col('f', ftitle), col('ac', aname), col('f', ftype),
                             col('n', folder), col('f', owner))
if deleted: sql += ' AND IFNULL(n.%s, 0) = 0' % deleted
rows = cur.execute(sql, (note_ent,)).fetchall()

def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1
        r |= (c & 0x7f) << s
        if c < 0x80: return r, i
        s += 7
def fields(b):
    i, n = 0, len(b)
    while i < n:
        key, i = varint(b, i)
        f, t = key >> 3, key & 7
        if t == 0: v, i = varint(b, i)
        elif t == 1: v = b[i:i + 8]; i += 8
        elif t == 2:
            l, i = varint(b, i); v = b[i:i + l]; i += l
        elif t == 5: v = b[i:i + 4]; i += 4
        else: return
        yield f, t, v
def note_text(blob):
    try:
        # The note text sits at the start of the document; never inflate more than 2 MB
        # (drawings and scanned pages can make a single note's data enormous).
        if blob[:2] == b'\x1f\x8b': blob = zlib.decompressobj(47).decompress(blob, 2000000)
        for f, t, v in fields(blob):
            if f == 2 and t == 2:
                for f2, t2, v2 in fields(v):
                    if f2 == 3 and t2 == 2:
                        for f3, t3, v3 in fields(v2):
                            if f3 == 2 and t3 == 2:
                                return v3.decode('utf-8', 'replace').replace('￼', '')
    except Exception:
        pass
    return ''

q = (a.get('query') or '').strip().lower()
want_folder = (a.get('folder') or '').strip().lower()
items = []
for pk, t, snip, m, lk, nd, fname, acct, fkind in rows:
    if fkind == 1 and not a.get('include_deleted'): continue
    path = '%s/%s' % (acct or '', fname or '')
    if want_folder and want_folder not in (str(fname or '').lower(), path.lower()) and not path.lower().endswith('/' + want_folder): continue
    items.append({'pk': pk, 'nd': nd, 'name': t or '', 'snippet': snip or '', 'modified': m or 0, 'locked': bool(lk), 'folder': fname, 'account': acct})

if q:
    bodies = {}
    if not a.get('titles_only'):
        ND = cols('ZICNOTEDATA')
        by_nd = notedata is not None
        key = 'Z_PK' if by_nd else ('ZNOTE' if 'ZNOTE' in ND else None)
        if key:
            ids = [(it['nd'] if by_nd else it['pk']) for it in items if not it['locked']]
            ids = [x for x in ids if x is not None]
            texts = {}
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                for k, data in cur.execute('SELECT %s, ZDATA FROM ZICNOTEDATA WHERE %s IN (%s)' % (key, key, ','.join('?' * len(chunk))), chunk):
                    if data: texts[k] = note_text(bytes(data))
                    if time.time() - started > 25:
                        partial = True
                        break
                if partial: break
            for it in items:
                k = it['nd'] if by_nd else it['pk']
                if k in texts: bodies[it['pk']] = texts[k]
    found = []
    for it in items:
        body = bodies.get(it['pk'], '')
        hay = (it['name'] + '\n' + body).lower()
        at = hay.find(q)
        if at < 0: continue
        if body:
            b_at = body.lower().find(q)
            if b_at >= 0:
                start = max(0, b_at - 60)
                it['snippet'] = ('…' if start else '') + body[start:b_at + 160].replace('\n', ' ')
        found.append(it)
    items = found

items.sort(key=lambda it: it['modified'], reverse=True)
total = len(items)
off, lim = int(a.get('offset') or 0), int(a.get('limit') or 20)
page = []
for it in items[off:off + lim]:
    page.append({
        'id': 'x-coredata://%s/ICNote/p%d' % (store, it['pk']),
        'name': it['name'],
        'modified': datetime.datetime.fromtimestamp(it['modified'] + 978307200, datetime.timezone.utc).isoformat() if it['modified'] else None,
        'folder': ('%s/%s' % (it['account'], it['folder'])) if it['account'] else it['folder'],
        'locked': it['locked'],
        'snippet': it['snippet'][:240],
    })
out({'total': total, 'items': page, 'via': 'database', 'partial': partial})
`;

export const NOTES_DB = `
function run(argv) {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const q = function (s) { return "'" + String(s).replace(/'/g, "'\\\\''") + "'"; };
  const PY = ${JSON.stringify(PY)};
  try {
    return app.doShellScript('/usr/bin/python3 -c ' + q(PY) + ' ' + q(argv[0]));
  } catch (e) {
    return JSON.stringify({ error: 'PYTHON_FAILED', detail: String(e) });
  }
}`;

export const NOTES_DB_PYTHON = PY;

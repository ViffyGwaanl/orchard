/**
 * Reads one email straight from Mail's on-disk store (.emlx) instead of asking
 * Mail.app, which has to scan tens of thousands of messages to find one id.
 * Runs as osascript -> /bin/sh -> python3 under Orchard Helper, so it uses the
 * helper's Full Disk Access. Python's email package handles MIME and every
 * charset Chinese mail uses (GB2312/GBK/GB18030/Big5).
 */

const PY = String.raw`
import sys, json, os, glob, re, html, email, time
from email import policy
a = json.loads(sys.argv[1])
mid = int(a['id'])
acct = a.get('account_id') or ''
box = a.get('mailbox') or ''
def out(o):
    sys.stdout.write(json.dumps(o, ensure_ascii=False)); sys.exit(0)
roots = sorted(glob.glob(os.path.expanduser('~/Library/Mail/V[0-9]*')), key=lambda p: int(re.sub(r'\D', '', os.path.basename(p)) or 0), reverse=True)
if not roots:
    out({'error': 'NO_ACCESS'})
base = roots[0]
k = mid // 1000
part = '/'.join(reversed(str(k))) if k else ''
rel = ('Data/%s/Messages' % part) if part else 'Data/Messages'
names = ['%d.emlx' % mid, '%d.partial.emlx' % mid]

def in_mbox(mbox):
    for store in glob.glob(os.path.join(glob.escape(mbox), '*')):
        for n in names:
            p = os.path.join(store, rel, n)
            if os.path.exists(p): return p
    return None

found = None
if acct and box:
    mbox = os.path.join(base, acct, *[s + '.mbox' for s in box.split('/')])
    found = in_mbox(mbox)
if not found and acct:
    started = time.time()
    for dirpath, dirnames, _ in os.walk(os.path.join(base, acct)):
        if time.time() - started > 20: break
        if dirpath.endswith('.mbox'):
            found = in_mbox(dirpath)
            if found: break
        dirnames[:] = [d for d in dirnames if d != 'Data' and not d.startswith('.')]
if not found:
    out({'error': 'NOT_FOUND'})

raw = open(found, 'rb').read()
nl = raw.find(b'\n')
try:
    length = int(raw[:nl].strip())
    body = raw[nl + 1: nl + 1 + length]
except ValueError:
    body = raw
msg = email.message_from_bytes(body, policy=policy.default)

def text_of(part):
    try:
        return part.get_content()
    except Exception:
        payload = part.get_payload(decode=True) or b''
        for cs in (part.get_content_charset(), 'utf-8', 'gb18030', 'big5', 'latin-1'):
            if not cs: continue
            try: return payload.decode(cs)
            except Exception: pass
        return payload.decode('utf-8', 'replace')

def html_to_text(h):
    h = re.sub(r'(?is)<(script|style|head)[^>]*>.*?</\1>', '', h)
    h = re.sub(r'(?i)<br\s*/?>', '\n', h)
    h = re.sub(r'(?i)</t[dh]>', '\t', h)
    h = re.sub(r'(?i)</(p|div|tr|li|h\d|table)>', '\n', h)
    h = re.sub(r'(?i)<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>', lambda m: m.group(2) if m.group(1) in m.group(2) else '%s (%s)' % (m.group(2), m.group(1)), h)
    h = re.sub(r'<[^>]+>', '', h)
    h = html.unescape(h)
    out_lines = []
    for line in h.split('\n'):
        cells = [re.sub(r'[ \u00a0\u200b]+', ' ', c).strip() for c in line.split('\t')]
        out_lines.append(' · '.join(c for c in cells if c))
    return re.sub(r'\n{3,}', '\n\n', '\n'.join(out_lines)).strip()

content = ''
try:
    part = msg.get_body(preferencelist=('plain', 'html'))
    if part is not None:
        content = text_of(part)
        if part.get_content_type() == 'text/html': content = html_to_text(content)
except Exception:
    content = ''
if not content and not msg.is_multipart():
    content = text_of(msg)
    if msg.get_content_type() == 'text/html': content = html_to_text(content)

atts = []
try:
    for p in msg.iter_attachments():
        fn = p.get_filename()
        if not fn: continue
        try: size = len(p.get_payload(decode=True) or b'')
        except Exception: size = None
        atts.append({'name': fn, 'mime': p.get_content_type(), 'size': size or None, 'downloaded': size not in (None, 0)})
except Exception:
    pass

def addrs(h):
    v = msg.get(h)
    if not v: return []
    try: return [str(x) for x in v.addresses]
    except Exception: return [str(v)]

out({
    'id': mid, 'subject': str(msg.get('subject') or ''), 'from': str(msg.get('from') or ''),
    'reply_to': str(msg.get('reply-to')) if msg.get('reply-to') else None,
    'to': addrs('to'), 'cc': addrs('cc'),
    'date': None, 'date_raw': str(msg.get('date') or ''), 'date_sent': None,
    'read': None, 'flagged': None, 'message_id': str(msg.get('message-id') or '') or None,
    'mailbox': box or None, 'account': None, 'attachments': atts,
    'content': content, 'partial': found.endswith('.partial.emlx'), 'via': 'file',
})
`;

export const MAIL_FILE_READ = `
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

export const MAIL_FILE_PYTHON = PY;

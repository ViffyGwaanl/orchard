/**
 * Sender statistics straight from Mail's Envelope Index (needs Full Disk Access,
 * runs under Orchard Helper like the other Python readers). Answers "who is
 * filling my inbox" over every message, not just the latest page.
 */

const PY = String.raw`
import sqlite3, sys, json, os, glob, re, urllib.parse, datetime
a = json.loads(sys.argv[1])
def out(o):
    sys.stdout.write(json.dumps(o, ensure_ascii=False)); sys.exit(0)
roots = sorted(glob.glob(os.path.expanduser('~/Library/Mail/V[0-9]*')), key=lambda p: int(re.sub(r'\D', '', os.path.basename(p)) or 0), reverse=True)
db = None
for r in roots:
    p = os.path.join(r, 'MailData', 'Envelope Index')
    if os.path.exists(p): db = p; break
if not db: out({'error': 'NO_ACCESS'})
try:
    con = sqlite3.connect('file:' + urllib.parse.quote(db) + '?mode=ro', uri=True)
    cur = con.cursor()
    cur.execute('SELECT 1 FROM sqlite_master LIMIT 1')
except Exception as e:
    out({'error': 'NO_ACCESS', 'detail': str(e)})
tables = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")}
inbox = "(LOWER(mb.url) LIKE '%/inbox'"
if 'labels' in tables:
    inbox += " OR m.ROWID IN (SELECT l.message_id FROM labels l JOIN mailboxes lb ON lb.ROWID = l.mailbox_id WHERE LOWER(lb.url) LIKE '%/inbox')"
inbox += ")"
where = ['m.deleted = 0', inbox]
args = []
if a.get('unread_only', True): where.append('m.read = 0')
if a.get('from'):
    where.append("(a.address LIKE ? OR a.comment LIKE ?)")
    pat = '%' + a['from'].replace('%', '').replace('_', '') + '%'
    args += [pat, pat]
if a.get('since_unix'):
    where.append('m.date_received >= ?'); args.append(int(a['since_unix']))
sql = ('SELECT LOWER(a.address), MAX(a.comment), COUNT(DISTINCT m.ROWID), MAX(m.date_received), '
       "GROUP_CONCAT(DISTINCT substr(mb.url, instr(mb.url, '://') + 3, 36)) "
       'FROM messages m LEFT JOIN addresses a ON a.ROWID = m.sender LEFT JOIN mailboxes mb ON mb.ROWID = m.mailbox '
       'WHERE ' + ' AND '.join(where) + ' GROUP BY LOWER(a.address) ORDER BY COUNT(DISTINCT m.ROWID) DESC')
rows = cur.execute(sql, args).fetchall()
def iso(v):
    if not v: return None
    v = v + 978307200 if v < 1.2e9 else v
    return datetime.datetime.fromtimestamp(v, datetime.timezone.utc).isoformat()
senders = []
total = 0
for addr, name, n, last, accts in rows:
    total += n
    senders.append({'address': addr or '', 'name': name or None, 'count': n, 'latest': iso(last), 'accounts': sorted(set((accts or '').split(','))) if accts else []})
lim = int(a.get('limit') or 50)
out({'total': total, 'sender_count': len(senders), 'senders': senders[:lim]})
`;

function wrap(py: string): string {
  return `
function run(argv) {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const q = function (s) { return "'" + String(s).replace(/'/g, "'\\\\''") + "'"; };
  const PY = ${JSON.stringify(py)};
  try {
    return app.doShellScript('/usr/bin/python3 -c ' + q(PY) + ' ' + q(argv[0]));
  } catch (e) {
    return JSON.stringify({ error: 'PYTHON_FAILED', detail: String(e) });
  }
}`;
}

export const MAIL_SENDERS = wrap(PY);
export const MAIL_SENDERS_PYTHON = PY;

/**
 * Bulk changes to every inbox message from one sender, done by Mail in a
 * single Apple Event per inbox. Arguments: account name, sender text,
 * action (mark_read|flag|trash|move), "1" for unread only, destination box.
 */
export const MAIL_BULK = String.raw`
on run argv
	set theAccount to item 1 of argv
	set theSender to item 2 of argv
	set theAction to item 3 of argv
	set unreadOnly to (item 4 of argv) is "1"
	set destName to item 5 of argv
	set total to 0
	tell application "Mail"
		set acc to account theAccount
		set boxes to {}
		repeat with b in (mailboxes of acc)
			set n to name of b
			if n is "INBOX" or n is "Inbox" or n is "收件箱" or n is "收件匣" then set end of boxes to b
		end repeat
		repeat with b in boxes
			if unreadOnly then
				set c to count of (every message of b whose sender contains theSender and read status is false)
			else
				set c to count of (every message of b whose sender contains theSender)
			end if
			if c > 0 then
				if unreadOnly then
					if theAction is "mark_read" then
						set read status of (every message of b whose sender contains theSender and read status is false) to true
					else if theAction is "flag" then
						set flagged status of (every message of b whose sender contains theSender and read status is false) to true
					else if theAction is "trash" then
						delete (every message of b whose sender contains theSender and read status is false)
					else if theAction is "move" then
						move (every message of b whose sender contains theSender and read status is false) to mailbox destName of acc
					end if
				else
					if theAction is "mark_read" then
						set read status of (every message of b whose sender contains theSender) to true
					else if theAction is "flag" then
						set flagged status of (every message of b whose sender contains theSender) to true
					else if theAction is "trash" then
						delete (every message of b whose sender contains theSender)
					else if theAction is "move" then
						move (every message of b whose sender contains theSender) to mailbox destName of acc
					end if
				end if
				set total to total + c
			end if
		end repeat
	end tell
	return "{\"changed\":" & total & "}"
end run
`;

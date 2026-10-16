/** JXA programs for Apple Mail. See notes.ts for the conventions. */

const PRELUDE = String.raw`
const Mail = Application('Mail');
function iso(d) { try { return d ? d.toISOString() : null; } catch (e) { return null; } }
function first(fn) { try { const r = fn(); return (r && r.length) ? r[0] : null; } catch (e) { return null; } }
const INBOX_NAMES = ['inbox', '收件箱', '收件匣', 'posteingang', 'boîte de réception', 'bandeja de entrada'];
function boxIn(acc, name) {
  const want = String(name).toLowerCase();
  const isInbox = INBOX_NAMES.indexOf(want) >= 0;
  let boxes = []; try { boxes = acc.mailboxes(); } catch (e) { return null; }
  for (let i = 0; i < boxes.length; i++) {
    let n = ''; try { n = String(boxes[i].name()).toLowerCase(); } catch (e) {}
    if (n === want || (isInbox && INBOX_NAMES.indexOf(n) >= 0)) return boxes[i];
  }
  return null;
}
function findMessage(id, hint) {
  id = Number(id);
  let m = null;
  if (hint && hint.account_id) {
    let acc = null; try { acc = Mail.accounts.byId(hint.account_id); acc.name(); } catch (e) { acc = null; }
    if (acc) {
      if (hint.mailbox) {
        m = first(function () { return acc.mailboxes.byName(hint.mailbox).messages.whose({ id: id })(); });
        if (m) return m;
        const b = boxIn(acc, hint.mailbox.split('/').pop());
        if (b) { m = first(function () { return b.messages.whose({ id: id })(); }); if (m) return m; }
      }
      // Stay inside the one account: scanning every mailbox of every account takes minutes.
      let boxes = []; try { boxes = acc.mailboxes(); } catch (e) {}
      for (let j = 0; j < boxes.length; j++) {
        m = first(function () { return boxes[j].messages.whose({ id: id })(); });
        if (m) return m;
      }
      return null;
    }
  }
  return first(function () { return Mail.inbox.messages.whose({ id: id })(); });
}
function recips(list) {
  try { return list.map(function (r) { let n = null; try { n = r.name(); } catch (e) {} return n ? n + ' <' + r.address() + '>' : r.address(); }); }
  catch (e) { return []; }
}
function safe(fn, d) { try { return fn(); } catch (e) { return d; } }
`;

function program(body: string): string {
  return `${PRELUDE}\nfunction run(argv) {\n  const a = JSON.parse(argv[0] || '{}');\n${body}\n}`;
}

export const MAIL_ACCOUNTS = program(String.raw`
  const out = Mail.accounts().map(function (acc) {
    const boxes = acc.mailboxes;
    const names = safe(function () { return boxes.name(); }, []);
    const unread = safe(function () { return boxes.unreadCount(); }, []);
    return {
      id: safe(function () { return acc.id(); }, null),
      name: safe(function () { return acc.name(); }, ''),
      enabled: safe(function () { return acc.enabled(); }, true),
      emails: safe(function () { return acc.emailAddresses(); }, []),
      mailboxes: names.map(function (n, i) { return { name: n, unread: unread[i] || 0 }; })
    };
  });
  return JSON.stringify({ inbox_unread: safe(function () { return Mail.inbox.unreadCount(); }, null), accounts: out });
`);

export const MAIL_INBOX_SEARCH = program(String.raw`
  let coll = Mail.inbox.messages;
  const filters = [];
  if (a.unread_only) filters.push({ readStatus: false });
  if (a.flagged_only) filters.push({ flaggedStatus: true });
  if (a.query) filters.push({ _or: [{ subject: { _contains: a.query } }, { sender: { _contains: a.query } }] });
  if (a.from) filters.push({ sender: { _contains: a.from } });
  if (filters.length === 1) coll = coll.whose(filters[0]);
  else if (filters.length > 1) coll = coll.whose({ _and: filters });
  const ids = coll.id(), subjects = coll.subject(), senders = coll.sender(), dates = coll.dateReceived(), reads = coll.readStatus();
  let flags = []; try { flags = coll.flaggedStatus(); } catch (e) {}
  const since = a.since ? new Date(a.since).getTime() : null;
  let idx = ids.map(function (_, i) { return i; });
  if (since) idx = idx.filter(function (i) { return dates[i] && dates[i].getTime() >= since; });
  idx.sort(function (x, y) { return (dates[y] ? dates[y].getTime() : 0) - (dates[x] ? dates[x].getTime() : 0); });
  const off = a.offset || 0, lim = a.limit || 25;
  const items = idx.slice(off, off + lim).map(function (i) {
    return { id: ids[i], subject: subjects[i], from: senders[i], date: iso(dates[i]), read: reads[i], flagged: !!flags[i], preview: null, mailbox: { mailbox: 'INBOX' } };
  });
  return JSON.stringify({ offset: off, has_more: idx.length > off + lim, total: idx.length, items: items });
`);

export const MAIL_READ = program(String.raw`
  const m = findMessage(a.id, a.hint);
  if (!m) return JSON.stringify({ error: 'NOT_FOUND', id: a.id });
  const box = safe(function () { return m.mailbox(); }, null);
  const out = {
    id: Number(a.id),
    subject: safe(function () { return m.subject(); }, ''),
    from: safe(function () { return m.sender(); }, ''),
    reply_to: safe(function () { return m.replyTo(); }, null),
    to: recips(safe(function () { return m.toRecipients(); }, [])),
    cc: recips(safe(function () { return m.ccRecipients(); }, [])),
    date: iso(safe(function () { return m.dateReceived(); }, null)),
    date_sent: iso(safe(function () { return m.dateSent(); }, null)),
    read: safe(function () { return m.readStatus(); }, null),
    flagged: safe(function () { return m.flaggedStatus(); }, null),
    message_id: safe(function () { return m.messageId(); }, null),
    mailbox: box ? safe(function () { return box.name(); }, null) : null,
    account: box ? safe(function () { return box.account().name(); }, null) : null,
    attachments: safe(function () {
      return m.mailAttachments().map(function (x) {
        return { name: safe(function () { return x.name(); }, null), mime: safe(function () { return x.mimeType(); }, null), size: safe(function () { return x.fileSize(); }, null), downloaded: safe(function () { return x.downloaded(); }, null) };
      });
    }, []),
    content: safe(function () { return m.content(); }, '')
  };
  if (a.mark_read) { try { m.readStatus = true; } catch (e) {} }
  return JSON.stringify(out);
`);

export const MAIL_COMPOSE = program(String.raw`
  const props = { subject: a.subject || '', content: a.body || '', visible: !a.send_now };
  if (a.from) props.sender = a.from;
  const msg = Mail.OutgoingMessage(props);
  Mail.outgoingMessages.push(msg);
  (a.to || []).forEach(function (r) { msg.toRecipients.push(Mail.ToRecipient(r)); });
  (a.cc || []).forEach(function (r) { msg.ccRecipients.push(Mail.CcRecipient(r)); });
  (a.bcc || []).forEach(function (r) { msg.bccRecipients.push(Mail.BccRecipient(r)); });
  (a.attachments || []).forEach(function (p) {
    msg.content.attachments.push(Mail.Attachment({ fileName: Path(p) }));
  });
  if (a.send_now) {
    if ((a.attachments || []).length) delay(1.5);
    const ok = msg.send();
    return JSON.stringify({ sent: ok !== false });
  }
  Mail.activate();
  return JSON.stringify({ opened: true });
`);

export const MAIL_UPDATE = program(String.raw`
  const done = [], failed = [];
  let target = null;
  (a.ids || []).forEach(function (id) {
    const m = findMessage(id, (a.hints || {})[String(id)]);
    if (!m) { failed.push({ id: id, message: 'not found' }); return; }
    const subject = safe(function () { return m.subject(); }, '');
    try {
      switch (a.action) {
        case 'mark_read': m.readStatus = true; break;
        case 'mark_unread': m.readStatus = false; break;
        case 'flag': m.flaggedStatus = true; break;
        case 'unflag': m.flaggedStatus = false; break;
        case 'trash': Mail.delete(m); break;
        case 'move': {
          let box = null;
          if (a.account) box = Mail.accounts.byName(a.account).mailboxes.byName(a.mailbox);
          else {
            const acc = safe(function () { return m.mailbox().account(); }, null);
            if (acc) box = acc.mailboxes.byName(a.mailbox);
          }
          if (!box) throw new Error('mailbox not found');
          box.name();
          Mail.move(m, { to: box });
          break;
        }
        default: throw new Error('unknown action');
      }
      done.push({ id: id, subject: subject });
    } catch (e) {
      failed.push({ id: id, subject: subject, message: String(e) });
    }
  });
  return JSON.stringify({ done: done, failed: failed });
`);

export const ALL_MAIL_SCRIPTS = { MAIL_ACCOUNTS, MAIL_INBOX_SEARCH, MAIL_READ, MAIL_COMPOSE, MAIL_UPDATE };

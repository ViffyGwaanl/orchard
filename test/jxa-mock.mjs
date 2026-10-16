/**
 * A small imitation of JavaScript for Automation's object model, good enough to
 * run Orchard's Notes and Mail scripts for real in Node: callable collections
 * with bulk property getters, byId/byName/whose, element proxies whose
 * properties are both callable and assignable, make/move/delete, and push.
 */
import vm from "node:vm";

function matches(el, filter) {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "_or") { if (!v.some((f) => matches(el, f))) return false; continue; }
    if (k === "_and") { if (!v.every((f) => matches(el, f))) return false; continue; }
    const actual = el._get(k);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("_contains" in v) { if (!String(actual ?? "").includes(String(v._contains))) return false; }
      else if ("_equals" in v) { if (actual !== v._equals) return false; }
    } else if (actual !== v) return false;
  }
  return true;
}

export function element(kind, data, app) {
  const target = { kind, data, app };
  const proxy = new Proxy(function () {}, {
    get(_, prop) {
      if (prop === "_get") return (k) => resolve(k);
      if (prop === "_data") return data;
      if (prop === "_kind") return kind;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      if (data[prop] && (data[prop]._isCollection || data[prop]._spec)) return data[prop];
      if (typeof data[`$${prop}`] === "function") return data[`$${prop}`];
      return () => {
        if (data[`__throws_${prop}`]) throw new Error(`Can't get ${prop}`);
        const v = resolve(prop);
        if (v === undefined) throw new Error(`Can't get ${kind}.${prop}`);
        return v;
      };
    },
    set(_, prop, value) {
      data[prop] = value;
      return true;
    },
  });
  function resolve(k) {
    const v = data[k];
    if (typeof v === "function" && !v._isCollection) return v.call(data, proxy);
    return v;
  }
  data._proxy = proxy;
  return proxy;
}

export function collection(getItems, opts = {}) {
  const fn = function () { return getItems(); };
  const proxy = new Proxy(fn, {
    apply() { return getItems(); },
    get(_, prop) {
      if (prop === "_isCollection") return true;
      if (prop === "length") return getItems().length;
      if (prop === "byId") return (id) => {
        const el = getItems().find((e) => e._get("id") === id);
        return el ?? element("missing", { __throws_name: true, __throws_id: true }, null);
      };
      if (prop === "byName") return (name) => {
        const el = getItems().find((e) => e._get("name") === name);
        if (!el) {
          return new Proxy(function () {}, { get(_, p) { if (p === "messages" || p === "notes" || p === "mailboxes") return collection(() => []); return () => { throw new Error(`Can't get ${name}`); }; } });
        }
        return el;
      };
      if (prop === "whose") return (filter) => collection(() => getItems().filter((e) => matches(e, filter)), opts);
      if (prop === "push") return (el) => { if (opts.onPush) opts.onPush(el); else throw new Error("push not supported"); return el; };
      if (typeof prop === "symbol") return undefined;
      // Bulk property getter, e.g. notes.name()
      const bulk = () => getItems().map((e) => e._get(prop));
      bulk._isCollection = false;
      return new Proxy(bulk, {
        get(t, p) {
          if (p === "name" || p === "id") {
            return () => getItems().map((e) => { const c = e._get(prop); return c && c._get ? c._get(p) : null; });
          }
          return t[p];
        },
      });
    },
  });
  return proxy;
}

let counter = 1000;
export function makeNotesApp(seed) {
  const app = {};
  const accounts = [];
  const allNotes = () => accounts.flatMap((a) => a.data.folderList.flatMap((f) => allFolderNotes(f)));
  const allFolderNotes = (f) => [...f.noteList, ...f.children.flatMap(allFolderNotes)];
  function mkFolder(name, account, parent) {
    const data = { id: `x-coredata://F/${counter++}`, name, noteList: [], children: [], account, parent };
    data.notes = collection(() => data.noteList, { onPush: (n) => { const nd = n._data; nd.folder = data; data.noteList.push(n); } });
    data.folders = collection(() => data.children.map((c) => c._proxy));
    data.container = () => parent ? parent._proxy : account._proxy;
    element("folder", data, app);
    return data;
  }
  function mkNote(folderData, name, body, extra = {}) {
    const data = {
      id: `x-coredata://N/ICNote/p${counter++}`, name, body, folder: folderData,
      creationDate: new Date("2026-09-01T08:00:00Z"), modificationDate: extra.modified ?? new Date(),
      passwordProtected: extra.locked ?? false, attachmentList: extra.attachments ?? [],
    };
    data.plaintext = (self) => String(data.body).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    data.container = () => data.folder._proxy;
    data.attachments = collection(() => data.attachmentList.map((n) => element("attachment", { name: n }, app)));
    const el = element("note", data, app);
    // Keep the name in sync with the first line of the body, as Notes does.
    Object.defineProperty(data, "body", {
      get() { return data._body; },
      set(v) { data._body = v; const first = String(v).split(/<\/(?:div|h1|h2|h3|p)>/i)[0].replace(/<[^>]+>/g, "").trim(); if (first) data.name = first; },
      configurable: true,
    });
    data.body = body;
    if (name) data.name = name;
    return el;
  }
  for (const acc of seed.accounts) {
    const adata = { id: `acc-${acc.name}`, name: acc.name, folderList: [] };
    adata.folders = collection(() => adata.folderList.map((f) => f._proxy));
    adata.defaultFolder = () => adata.folderList[0]._proxy;
    element("account", adata, app);
    accounts.push({ data: adata });
    for (const f of acc.folders) {
      const fd = mkFolder(f.name, adata, null);
      adata.folderList.push(fd);
      for (const n of f.notes ?? []) fd.noteList.push(mkNote(fd, n.name, n.body, n));
      for (const sub of f.subfolders ?? []) {
        const sd = mkFolder(sub.name, adata, fd);
        fd.children.push(sd);
        for (const n of sub.notes ?? []) sd.noteList.push(mkNote(sd, n.name, n.body, n));
      }
    }
  }
  const api = {
    accounts: collection(() => accounts.map((a) => a.data._proxy)),
    notes: collection(() => allNotes()),
    folders: collection(() => accounts.flatMap((a) => a.data.folderList.map((f) => f._proxy))),
    defaultAccount: () => accounts[0].data._proxy,
    make: ({ new: kind, at, withProperties }) => {
      const fd = at._data;
      const n = mkNote(fd, null, withProperties.body);
      fd.noteList.push(n);
      return n;
    },
    Note: (props) => mkNote({ noteList: [] }, null, props.body),
    move: (n, { to }) => {
      const nd = n._data;
      nd.folder.noteList.splice(nd.folder.noteList.indexOf(n), 1);
      nd.folder = to._data;
      to._data.noteList.push(n);
    },
    delete: (n) => {
      const nd = n._data;
      nd.folder.noteList.splice(nd.folder.noteList.indexOf(n), 1);
      api._deleted.push(nd.name);
    },
    _deleted: [],
  };
  return api;
}

export function makeMailApp(seed) {
  const sent = [];
  const opened = [];
  const accounts = seed.accounts.map((acc) => {
    const adata = { id: acc.id, name: acc.name, enabled: true, emailAddresses: acc.emails, boxList: [] };
    const aEl = element("account", adata);
    for (const b of acc.mailboxes) {
      const bdata = { name: b.name, msgList: [], account: () => aEl };
      bdata.messages = collection(() => bdata.msgList);
      bdata.unreadCount = () => bdata.msgList.filter((m) => !m._get("readStatus")).length;
      const bEl = element("mailbox", bdata);
      for (const m of b.messages ?? []) {
        const md = { ...m, readStatus: m.readStatus ?? false, flaggedStatus: m.flaggedStatus ?? false, mailbox: () => bEl };
        md.toRecipients = collection(() => (m.to ?? []).map((r) => element("recipient", { address: r, name: null })));
        md.ccRecipients = collection(() => []);
        md.mailAttachments = collection(() => (m.attachments ?? []).map((n) => element("att", { name: n, mimeType: "application/pdf", fileSize: 2048, downloaded: true })));
        bdata.msgList.push(element("message", md));
      }
      adata.boxList.push(bEl);
    }
    adata.mailboxes = collection(() => adata.boxList);
    return aEl;
  });
  const inboxMsgs = () => accounts.flatMap((a) => a._data.boxList.filter((b) => b._get("name") === "INBOX").flatMap((b) => b._data.msgList));
  const inboxData = { name: "Inbox" };
  inboxData.messages = collection(inboxMsgs);
  inboxData.unreadCount = () => inboxMsgs().filter((m) => !m._get("readStatus")).length;
  const api = {
    accounts: collection(() => accounts),
    inbox: element("mailbox", inboxData),
    outgoingMessages: collection(() => [], { onPush: () => {} }),
    OutgoingMessage: (props) => {
      const data = { ...props, to: [], cc: [], bcc: [], files: [] };
      data.toRecipients = collection(() => data.to, { onPush: (r) => data.to.push(r) });
      data.ccRecipients = collection(() => data.cc, { onPush: (r) => data.cc.push(r) });
      data.bccRecipients = collection(() => data.bcc, { onPush: (r) => data.bcc.push(r) });
      const body = props.content;
      const content = () => body;
      content._spec = true;
      content.attachments = collection(() => data.files, { onPush: (f) => data.files.push(f) });
      data.content = content;
      data.body = body;
      data.$send = () => { sent.push(data); return true; };
      if (props.visible) opened.push(data);
      return element("outgoing", data);
    },
    ToRecipient: (r) => r, CcRecipient: (r) => r, BccRecipient: (r) => r,
    Attachment: (a) => a,
    activate: () => {},
    delete: (m) => { m._data.deleted = true; },
    move: (m, { to }) => { m._data.movedTo = to._get("name"); },
    _sent: sent,
    _opened: opened,
  };
  return api;
}

export function runJxa(script, apps, args) {
  const ctx = vm.createContext({
    Application: (name) => {
      if (!apps[name]) throw new Error(`No mock for ${name}`);
      return apps[name];
    },
    Path: (p) => ({ path: p }),
    delay: () => {},
    JSON, Date, String, Number, Object, Math, Array, Error,
  });
  vm.runInContext(script, ctx, { filename: "jxa.js" });
  return vm.runInContext("run", ctx)(args);
}

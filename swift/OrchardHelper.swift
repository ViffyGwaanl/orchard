// Orchard Helper
// A small native process that gives the Orchard MCP server fast, first-class
// access to Reminders, Calendar and Contacts (EventKit / Contacts.framework),
// read access to the Messages and Mail databases, and a place to run Apple
// Events scripts under one stable privacy identity.
//
// Protocol: newline-delimited JSON on stdin/stdout.
//   request  {"id": 1, "method": "reminders.find", "params": {...}}
//   response {"id": 1, "ok": true, "result": ...}
//            {"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}
//
// Build: see src/helper/build.ts (swiftc + embedded Info.plist + ad-hoc sign).
// The TCC re-exec technique is adapted from high5-ventures/apple-reminders-for-claude (MIT).

import Foundation
import EventKit
import Contacts
import CoreServices
import CoreGraphics
import SQLite3
import Darwin

let HELPER_VERSION = "1.0.0"

// MARK: - TCC responsibility

// Claude Desktop does not declare Reminders/Calendar/Contacts usage strings,
// so privacy requests attributed to it are refused without a prompt. Re-exec
// ourselves as our own responsible process so macOS uses the usage strings
// embedded in this binary and lists "Orchard Helper" in System Settings.
let disclaimGuard = "ORCHARD_HELPER_DISCLAIMED"

func reexecDisclaimingResponsibility() {
    let env = ProcessInfo.processInfo.environment
    if env[disclaimGuard] != nil || env["ORCHARD_NO_DISCLAIM"] == "1" { return }
    typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else { return }
    let setDisclaim = unsafeBitCast(symbol, to: SetDisclaim.self)
    var pathBuf = [CChar](repeating: 0, count: Int(PATH_MAX))
    var size = UInt32(pathBuf.count)
    guard _NSGetExecutablePath(&pathBuf, &size) == 0 else { return }
    var attrs: posix_spawnattr_t?
    guard posix_spawnattr_init(&attrs) == 0 else { return }
    defer { posix_spawnattr_destroy(&attrs) }
    guard posix_spawnattr_setflags(&attrs, Int16(POSIX_SPAWN_SETEXEC)) == 0, setDisclaim(&attrs, 1) == 0 else { return }
    setenv(disclaimGuard, "1", 1)
    posix_spawn(nil, pathBuf, nil, &attrs, CommandLine.unsafeArgv, environ)
    unsetenv(disclaimGuard)
}

// MARK: - Basics

typealias JSON = [String: Any]

struct HelperError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

func str(_ p: JSON, _ k: String) -> String? {
    if let s = p[k] as? String { return s }
    return nil
}
func nonEmpty(_ p: JSON, _ k: String) -> String? {
    guard let s = str(p, k)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
    return s
}
func int(_ p: JSON, _ k: String) -> Int? {
    if let i = p[k] as? Int { return i }
    if let d = p[k] as? Double { return Int(d) }
    if let n = p[k] as? NSNumber { return n.intValue }
    return nil
}
func bool(_ p: JSON, _ k: String) -> Bool? {
    if let b = p[k] as? Bool { return b }
    if let n = p[k] as? NSNumber { return n.boolValue }
    return nil
}
func strings(_ p: JSON, _ k: String) -> [String]? {
    if let a = p[k] as? [Any] { return a.compactMap { $0 as? String } }
    return nil
}
func dict(_ p: JSON, _ k: String) -> JSON? { p[k] as? JSON }
func has(_ p: JSON, _ k: String) -> Bool { p.keys.contains(k) }
func isNull(_ p: JSON, _ k: String) -> Bool { p[k] is NSNull }
func required(_ p: JSON, _ k: String) throws -> String {
    guard let v = nonEmpty(p, k) else { throw HelperError("BAD_PARAMS", "Missing required parameter '\(k)'.") }
    return v
}

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = TimeZone.current
    return f
}()
func orNull(_ v: Any?) -> Any {
    if let v = v { return v }
    return NSNull()
}
func blankAsNull(_ s: String) -> Any {
    if s.isEmpty { return NSNull() }
    return s
}
func iso(_ d: Date?) -> Any { orNull(d.map { isoFormatter.string(from: $0) }) }

let dayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy-MM-dd"
    return f
}()
let timeFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.current
    f.dateFormat = "HH:mm"
    return f
}()

// Wall-clock date components sent by the Node side: {y, m, d, H?, M?}
func wallComponents(_ j: JSON) throws -> DateComponents {
    guard let y = int(j, "y"), let m = int(j, "m"), let d = int(j, "d") else {
        throw HelperError("BAD_DATE", "Date needs y, m and d.")
    }
    var c = DateComponents()
    c.calendar = Calendar(identifier: .gregorian)
    c.year = y; c.month = m; c.day = d
    if let h = int(j, "H") {
        c.hour = h
        c.minute = int(j, "M") ?? 0
        c.second = 0
        c.timeZone = TimeZone.current
    }
    return c
}
func wallDate(_ j: JSON) throws -> Date {
    var c = try wallComponents(j)
    if c.hour == nil { c.hour = 0; c.minute = 0; c.second = 0 }
    c.timeZone = TimeZone.current
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone.current
    guard let date = cal.date(from: c) else { throw HelperError("BAD_DATE", "Invalid date \(j).") }
    return date
}
func componentsJSON(_ c: DateComponents?) -> Any {
    guard let c = c, c.year != nil, c.month != nil, c.day != nil else { return NSNull() }
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = c.timeZone ?? TimeZone.current
    var copy = c
    copy.calendar = cal
    let hasTime = c.hour != nil
    if !hasTime { copy.hour = 0; copy.minute = 0 }
    guard let date = cal.date(from: copy) else { return NSNull() }
    var out: JSON = ["date": dayFormatter.string(from: date), "all_day": !hasTime, "iso": iso(date)]
    out["time"] = hasTime ? timeFormatter.string(from: date) as Any : NSNull() as Any
    return out
}

func fourCC(_ s: String) -> UInt32 {
    var r: UInt32 = 0
    for b in s.utf8.prefix(4) { r = (r << 8) | UInt32(b) }
    return r
}

// MARK: - Output

let outLock = NSLock()
func send(_ obj: JSON) {
    var data: Data
    do {
        data = try JSONSerialization.data(withJSONObject: obj, options: [])
    } catch {
        let fallback: JSON = ["id": orNull(obj["id"]), "ok": false,
                              "error": ["code": "ENCODE_FAILED", "message": "Could not encode result: \(error)"]]
        data = (try? JSONSerialization.data(withJSONObject: fallback, options: [])) ?? Data()
    }
    data.append(0x0A)
    outLock.lock()
    FileHandle.standardOutput.write(data)
    outLock.unlock()
}

// MARK: - EventKit

final class EK {
    static var store = EKEventStore()

    static func statusString(_ type: EKEntityType) -> String {
        switch EKEventStore.authorizationStatus(for: type).rawValue {
        case 0: return "not_determined"
        case 1: return "restricted"
        case 2: return "denied"
        case 3: return "granted"
        case 4: return "write_only"
        default: return "unknown"
        }
    }

    static func request(_ type: EKEntityType) -> JSON {
        let sem = DispatchSemaphore(value: 0)
        var granted = false
        var message: String? = nil
        let s = EKEventStore()
        let done: (Bool, Error?) -> Void = { g, e in granted = g; message = e?.localizedDescription; sem.signal() }
        if #available(macOS 14.0, *) {
            if type == .reminder { s.requestFullAccessToReminders(completion: done) }
            else { s.requestFullAccessToEvents(completion: done) }
        } else {
            s.requestAccess(to: type, completion: done)
        }
        let waited = sem.wait(timeout: .now() + 180)
        if granted { store = EKEventStore() }
        return ["granted": granted, "timed_out": waited == .timedOut,
                "status": statusString(type), "message": orNull(message)]
    }

    static func ensure(_ type: EKEntityType) throws {
        let st = statusString(type)
        if st == "granted" { return }
        if st == "not_determined" {
            let r = request(type)
            if (r["granted"] as? Bool) == true { return }
        }
        let what = type == .reminder ? "Reminders" : "Calendars"
        throw HelperError("PERMISSION_DENIED",
            "\(what) access is not granted to Orchard Helper. Open System Settings > Privacy & Security > \(what) and turn on Orchard Helper, then try again. (status: \(statusString(type)))")
    }

    static func hex(_ c: CGColor?) -> Any {
        guard let c = c, let comps = c.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components, comps.count >= 3 else { return NSNull() }
        return String(format: "#%02X%02X%02X", Int(comps[0] * 255), Int(comps[1] * 255), Int(comps[2] * 255))
    }

    static func calendarJSON(_ c: EKCalendar, isDefault: Bool) -> JSON {
        return ["id": c.calendarIdentifier, "title": c.title, "color": hex(c.cgColor),
                "source": orNull(c.source?.title), "writable": c.allowsContentModifications,
                "default": isDefault]
    }

    static func calendars(_ type: EKEntityType, ids: [String]?, names: [String]?) throws -> [EKCalendar]? {
        if (ids == nil || ids!.isEmpty) && (names == nil || names!.isEmpty) { return nil }
        let all = store.calendars(for: type)
        var out: [EKCalendar] = []
        for id in ids ?? [] {
            guard let c = all.first(where: { $0.calendarIdentifier == id }) else {
                throw HelperError("NOT_FOUND", "No \(type == .reminder ? "reminder list" : "calendar") with id \(id).")
            }
            out.append(c)
        }
        for n in names ?? [] {
            let matches = all.filter { $0.title.compare(n, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame }
            if matches.isEmpty {
                let titles = all.map { $0.title }.joined(separator: ", ")
                throw HelperError("NOT_FOUND", "No \(type == .reminder ? "reminder list" : "calendar") named '\(n)'. Available: \(titles)")
            }
            out.append(contentsOf: matches)
        }
        return out
    }

    static func oneCalendar(_ type: EKEntityType, _ p: JSON, idKey: String, nameKey: String) throws -> EKCalendar? {
        let ids = nonEmpty(p, idKey).map { [$0] }
        let names = nonEmpty(p, nameKey).map { [$0] }
        return try calendars(type, ids: ids, names: names)?.first
    }

    // Alarms: [{"relative_minutes": -2880}] or [{"at": {y,m,d,H,M}}]
    static func alarms(_ specs: [Any]) throws -> [EKAlarm] {
        var out: [EKAlarm] = []
        for s in specs {
            guard let j = s as? JSON else { continue }
            if let at = dict(j, "at") {
                out.append(EKAlarm(absoluteDate: try wallDate(at)))
            } else if let mins = int(j, "relative_minutes") {
                out.append(EKAlarm(relativeOffset: TimeInterval(mins * 60)))
            } else {
                throw HelperError("BAD_ALARM", "Each alarm needs 'at' or 'relative_minutes'.")
            }
        }
        return out
    }

    static func alarmJSON(_ a: EKAlarm) -> JSON {
        if let d = a.absoluteDate { return ["at": iso(d)] }
        return ["relative_minutes": Int(a.relativeOffset / 60)]
    }

    // Recurrence: {"frequency": "daily|weekly|monthly|yearly", "interval": 1,
    //              "days_of_week": [1..7, 1=Sunday], "until": {y,m,d}, "count": 10}
    static func recurrence(_ j: JSON) throws -> EKRecurrenceRule {
        let freq: EKRecurrenceFrequency
        switch (str(j, "frequency") ?? "").lowercased() {
        case "daily": freq = .daily
        case "weekly": freq = .weekly
        case "monthly": freq = .monthly
        case "yearly": freq = .yearly
        default: throw HelperError("BAD_RECURRENCE", "frequency must be daily, weekly, monthly or yearly.")
        }
        let interval = max(1, int(j, "interval") ?? 1)
        var end: EKRecurrenceEnd? = nil
        if let u = dict(j, "until") {
            var c = try wallComponents(u)
            c.hour = 23; c.minute = 59
            var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone.current
            if let d = cal.date(from: c) { end = EKRecurrenceEnd(end: d) }
        } else if let n = int(j, "count"), n > 0 {
            end = EKRecurrenceEnd(occurrenceCount: n)
        }
        var days: [EKRecurrenceDayOfWeek]? = nil
        if let dw = j["days_of_week"] as? [Any] {
            days = dw.compactMap { v -> EKRecurrenceDayOfWeek? in
                let n = (v as? Int) ?? (v as? NSNumber)?.intValue ?? 0
                guard let wd = EKWeekday(rawValue: n) else { return nil }
                return EKRecurrenceDayOfWeek(wd)
            }
            if days!.isEmpty { days = nil }
        }
        return EKRecurrenceRule(recurrenceWith: freq, interval: interval, daysOfTheWeek: days,
                                daysOfTheMonth: nil, monthsOfTheYear: nil, weeksOfTheYear: nil,
                                daysOfTheYear: nil, setPositions: nil, end: end)
    }

    static func recurrenceJSON(_ r: EKRecurrenceRule) -> JSON {
        let f: String
        switch r.frequency {
        case .daily: f = "daily"
        case .weekly: f = "weekly"
        case .monthly: f = "monthly"
        case .yearly: f = "yearly"
        @unknown default: f = "unknown"
        }
        var out: JSON = ["frequency": f, "interval": r.interval]
        if let days = r.daysOfTheWeek, !days.isEmpty { out["days_of_week"] = days.map { $0.dayOfTheWeek.rawValue } }
        if let end = r.recurrenceEnd {
            if let d = end.endDate { out["until"] = dayFormatter.string(from: d) }
            if end.occurrenceCount > 0 { out["count"] = end.occurrenceCount }
        }
        return out
    }

    static func priorityName(_ p: Int) -> String {
        switch p {
        case 1...4: return "high"
        case 5: return "medium"
        case 6...9: return "low"
        default: return "none"
        }
    }
    static func priorityValue(_ s: String) throws -> Int {
        switch s.lowercased() {
        case "high": return 1
        case "medium": return 5
        case "low": return 9
        case "none": return 0
        default: throw HelperError("BAD_PRIORITY", "priority must be high, medium, low or none.")
        }
    }

    // MARK: Reminders

    static func reminderJSON(_ r: EKReminder) -> JSON {
        var out: JSON = [
            "id": r.calendarItemIdentifier,
            "title": r.title ?? "",
            "notes": orNull(r.notes),
            "list": orNull(r.calendar?.title),
            "list_id": orNull(r.calendar?.calendarIdentifier),
            "completed": r.isCompleted,
            "completed_at": iso(r.completionDate),
            "priority": priorityName(r.priority),
            "due": componentsJSON(r.dueDateComponents),
            "start": componentsJSON(r.startDateComponents),
            "url": orNull(r.url?.absoluteString),
            "created_at": iso(r.creationDate),
            "modified_at": iso(r.lastModifiedDate),
        ]
        out["alarms"] = (r.alarms ?? []).map { alarmJSON($0) }
        out["recurrence"] = orNull((r.recurrenceRules ?? []).first.map { recurrenceJSON($0) })
        return out
    }

    static func fetch(_ predicate: NSPredicate) -> [EKReminder] {
        let sem = DispatchSemaphore(value: 0)
        var result: [EKReminder] = []
        store.fetchReminders(matching: predicate) { rs in
            result = rs ?? []
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 60)
        return result
    }

    static func reminderLists(_ p: JSON) throws -> Any {
        try ensure(.reminder)
        let def = store.defaultCalendarForNewReminders()
        let cals = store.calendars(for: .reminder)
        let open = fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: cals))
        var counts: [String: Int] = [:]
        for r in open { if let id = r.calendar?.calendarIdentifier { counts[id, default: 0] += 1 } }
        return cals.map { c -> JSON in
            var j = calendarJSON(c, isDefault: c.calendarIdentifier == def?.calendarIdentifier)
            j["open_count"] = counts[c.calendarIdentifier] ?? 0
            return j
        }
    }

    // params: lists[], list_ids[], status open|completed|all, due_from{}, due_to{} (inclusive day bounds),
    //         include_undated (bool, default true when no due range), query, priority, completed_from{}, limit, offset
    static func findReminders(_ p: JSON) throws -> Any {
        try ensure(.reminder)
        let cals = try calendars(.reminder, ids: strings(p, "list_ids"), names: strings(p, "lists"))
        let status = (str(p, "status") ?? "open").lowercased()
        let dueFrom = try dict(p, "due_from").map { try wallDate($0) }
        let dueToDay = try dict(p, "due_to").map { try wallDate($0) }
        let dueTo = dueToDay.map { Calendar.current.date(byAdding: .day, value: 1, to: $0)! }
        var items: [EKReminder] = []
        if status == "open" || status == "all" {
            if dueFrom != nil || dueTo != nil {
                // EventKit requires both bounds to be useful; use a wide window for the missing one.
                let from = dueFrom ?? Date(timeIntervalSince1970: 0)
                let to = dueTo ?? Date(timeIntervalSinceNow: 3650 * 86400)
                items += fetch(store.predicateForIncompleteReminders(withDueDateStarting: from, ending: to, calendars: cals))
            } else {
                items += fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: cals))
            }
        }
        if status == "completed" || status == "all" {
            let cFrom = try dict(p, "completed_from").map { try wallDate($0) } ?? Date(timeIntervalSinceNow: -30 * 86400)
            var done = fetch(store.predicateForCompletedReminders(withCompletionDateStarting: cFrom, ending: Date(timeIntervalSinceNow: 86400), calendars: cals))
            if dueFrom != nil || dueTo != nil {
                done = done.filter { r in
                    guard let c = r.dueDateComponents, let d = Calendar.current.date(from: c) else { return false }
                    if let f = dueFrom, d < f { return false }
                    if let t = dueTo, d >= t { return false }
                    return true
                }
            }
            items += done
        }
        if let q = nonEmpty(p, "query") {
            items = items.filter { r in
                (r.title ?? "").localizedCaseInsensitiveContains(q) || (r.notes ?? "").localizedCaseInsensitiveContains(q)
            }
        }
        if let pr = nonEmpty(p, "priority") {
            let want = pr.lowercased()
            items = items.filter { priorityName($0.priority) == want }
        }
        // Sort: dated first by due date, then undated by creation date (newest first); completed by completion date desc.
        func dueDate(_ r: EKReminder) -> Date? {
            guard let c = r.dueDateComponents else { return nil }
            var cc = c; if cc.hour == nil { cc.hour = 0; cc.minute = 0 }
            return Calendar.current.date(from: cc)
        }
        items.sort { a, b in
            if a.isCompleted != b.isCompleted { return !a.isCompleted }
            if a.isCompleted { return (a.completionDate ?? .distantPast) > (b.completionDate ?? .distantPast) }
            let da = dueDate(a), db = dueDate(b)
            switch (da, db) {
            case let (x?, y?): return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return (a.creationDate ?? .distantPast) > (b.creationDate ?? .distantPast)
            }
        }
        let total = items.count
        let offset = max(0, int(p, "offset") ?? 0)
        let limit = max(1, min(500, int(p, "limit") ?? 50))
        let page = Array(items.dropFirst(offset).prefix(limit))
        return ["total": total, "offset": offset, "items": page.map { reminderJSON($0) }] as JSON
    }

    static func reminder(_ id: String) throws -> EKReminder {
        guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else {
            throw HelperError("NOT_FOUND", "No reminder with id \(id). Use reminders_find to get current ids.")
        }
        return r
    }

    static func applyReminderFields(_ r: EKReminder, _ j: JSON, isNew: Bool) throws {
        if let t = str(j, "title") { r.title = t }
        if has(j, "notes") { r.notes = isNull(j, "notes") ? nil : str(j, "notes") }
        if let pr = nonEmpty(j, "priority") { r.priority = try priorityValue(pr) }
        if has(j, "url") {
            if let u = nonEmpty(j, "url") { r.url = URL(string: u) } else { r.url = nil }
        }
        if has(j, "list") || has(j, "list_id") {
            if let c = try oneCalendar(.reminder, j, idKey: "list_id", nameKey: "list") { r.calendar = c }
        }
        if has(j, "due") {
            if let d = dict(j, "due") { r.dueDateComponents = try wallComponents(d) } else { r.dueDateComponents = nil }
        }
        if has(j, "start") {
            if let d = dict(j, "start") { r.startDateComponents = try wallComponents(d) } else { r.startDateComponents = nil }
        }
        if has(j, "alarms") {
            for a in r.alarms ?? [] { r.removeAlarm(a) }
            for a in try alarms((j["alarms"] as? [Any]) ?? []) { r.addAlarm(a) }
        }
        if has(j, "recurrence") {
            for rule in r.recurrenceRules ?? [] { r.removeRecurrenceRule(rule) }
            if let rj = dict(j, "recurrence") {
                if r.dueDateComponents == nil { throw HelperError("BAD_RECURRENCE", "A repeating reminder needs a due date.") }
                r.addRecurrenceRule(try recurrence(rj))
            }
        }
        if let c = bool(j, "completed") { r.isCompleted = c }
    }

    static func createReminders(_ p: JSON) throws -> Any {
        try ensure(.reminder)
        guard let items = p["items"] as? [Any], !items.isEmpty else { throw HelperError("BAD_PARAMS", "items must be a non-empty array.") }
        var created: [JSON] = []
        var failed: [JSON] = []
        for (i, any) in items.enumerated() {
            guard let j = any as? JSON else { continue }
            do {
                guard let title = nonEmpty(j, "title") else { throw HelperError("BAD_PARAMS", "Each reminder needs a title.") }
                let r = EKReminder(eventStore: store)
                r.title = title
                if let c = try oneCalendar(.reminder, j, idKey: "list_id", nameKey: "list") { r.calendar = c }
                else {
                    guard let def = store.defaultCalendarForNewReminders() else { throw HelperError("NO_DEFAULT_LIST", "There is no default reminder list. Pass a list name.") }
                    r.calendar = def
                }
                try applyReminderFields(r, j, isNew: true)
                try store.save(r, commit: false)
                created.append(reminderJSON(r))
            } catch let e as HelperError {
                failed.append(["index": i, "title": str(j, "title") ?? "", "code": e.code, "message": e.message])
            } catch {
                failed.append(["index": i, "title": str(j, "title") ?? "", "code": "SAVE_FAILED", "message": error.localizedDescription])
            }
        }
        if !created.isEmpty {
            do { try store.commit() } catch {
                store.reset()
                throw HelperError("SAVE_FAILED", "Could not save reminders: \(error.localizedDescription)")
            }
        }
        return ["created": created, "failed": failed]
    }

    static func getReminder(_ p: JSON) throws -> Any {
        try ensure(.reminder)
        return reminderJSON(try reminder(try required(p, "id")))
    }

    static func updateReminder(_ p: JSON) throws -> Any {
        try ensure(.reminder)
        let r = try reminder(try required(p, "id"))
        try applyReminderFields(r, p, isNew: false)
        do { try store.save(r, commit: true) } catch {
            store.reset()
            throw HelperError("SAVE_FAILED", error.localizedDescription)
        }
        return reminderJSON(r)
    }

    static func setCompleted(_ p: JSON) throws -> Any {
        try ensure(.reminder)
        let ids = strings(p, "ids") ?? []
        let done = bool(p, "completed") ?? true
        var changed: [JSON] = []
        var failed: [JSON] = []
        for id in ids {
            do {
                let r = try reminder(id)
                r.isCompleted = done
                try store.save(r, commit: false)
                changed.append(["id": id, "title": r.title ?? ""])
            } catch let e as HelperError {
                failed.append(["id": id, "message": e.message])
            } catch {
                failed.append(["id": id, "message": error.localizedDescription])
            }
        }
        if !changed.isEmpty { try store.commit() }
        return ["changed": changed, "failed": failed, "completed": done] as JSON
    }

    static func deleteReminders(_ p: JSON) throws -> Any {
        try ensure(.reminder)
        var deleted: [JSON] = []
        var failed: [JSON] = []
        for id in strings(p, "ids") ?? [] {
            do {
                let r = try reminder(id)
                let title = r.title ?? ""
                try store.remove(r, commit: false)
                deleted.append(["id": id, "title": title])
            } catch let e as HelperError {
                failed.append(["id": id, "message": e.message])
            } catch {
                failed.append(["id": id, "message": error.localizedDescription])
            }
        }
        if !deleted.isEmpty { try store.commit() }
        return ["deleted": deleted, "failed": failed]
    }

    static func manageList(_ p: JSON) throws -> Any {
        try ensure(.reminder)
        let action = try required(p, "action")
        switch action {
        case "create":
            let name = try required(p, "name")
            let c = EKCalendar(for: .reminder, eventStore: store)
            c.title = name
            guard let src = store.defaultCalendarForNewReminders()?.source ?? store.sources.first(where: { $0.sourceType == .calDAV || $0.sourceType == .local }) else {
                throw HelperError("NO_SOURCE", "Could not find an account to create the list in.")
            }
            c.source = src
            try store.saveCalendar(c, commit: true)
            return calendarJSON(c, isDefault: false)
        case "rename":
            guard let c = try oneCalendar(.reminder, p, idKey: "list_id", nameKey: "list") else { throw HelperError("BAD_PARAMS", "Pass list or list_id.") }
            c.title = try required(p, "name")
            try store.saveCalendar(c, commit: true)
            return calendarJSON(c, isDefault: false)
        case "delete":
            guard let c = try oneCalendar(.reminder, p, idKey: "list_id", nameKey: "list") else { throw HelperError("BAD_PARAMS", "Pass list or list_id.") }
            let title = c.title
            try store.removeCalendar(c, commit: true)
            return ["deleted": title]
        default:
            throw HelperError("BAD_PARAMS", "action must be create, rename or delete.")
        }
    }

    // MARK: Calendar

    static func eventJSON(_ e: EKEvent) -> JSON {
        var out: JSON = [
            "id": e.eventIdentifier ?? e.calendarItemIdentifier,
            "title": e.title ?? "",
            "calendar": orNull(e.calendar?.title),
            "calendar_id": orNull(e.calendar?.calendarIdentifier),
            "start": iso(e.startDate),
            "end": iso(e.endDate),
            "all_day": e.isAllDay,
            "location": orNull(e.location),
            "notes": orNull(e.notes),
            "url": orNull(e.url?.absoluteString),
            "recurring": e.hasRecurrenceRules,
            "occurrence_date": iso(e.occurrenceDate),
            "availability": e.availability.rawValue,
        ]
        out["alarms"] = (e.alarms ?? []).map { alarmJSON($0) }
        if let rule = e.recurrenceRules?.first { out["recurrence"] = recurrenceJSON(rule) }
        if let atts = e.attendees, !atts.isEmpty {
            out["attendees"] = atts.map { a -> JSON in
                ["name": orNull(a.name), "email": a.url.absoluteString.replacingOccurrences(of: "mailto:", with: ""),
                 "status": a.participantStatus.rawValue]
            }
        }
        if let o = e.organizer { out["organizer"] = o.name ?? o.url.absoluteString }
        return out
    }

    static func calendarList(_ p: JSON) throws -> Any {
        try ensure(.event)
        let def = store.defaultCalendarForNewEvents
        return store.calendars(for: .event).map { calendarJSON($0, isDefault: $0.calendarIdentifier == def?.calendarIdentifier) }
    }

    static func findEvents(_ p: JSON) throws -> Any {
        try ensure(.event)
        guard let fromJ = dict(p, "from"), let toJ = dict(p, "to") else { throw HelperError("BAD_PARAMS", "from and to are required.") }
        let from = try wallDate(fromJ)
        var to = try wallDate(toJ)
        if int(toJ, "H") == nil { to = Calendar.current.date(byAdding: .day, value: 1, to: to)! }
        guard to > from else { throw HelperError("BAD_PARAMS", "'to' must be after 'from'.") }
        let cals = try calendars(.event, ids: strings(p, "calendar_ids"), names: strings(p, "calendars"))
        var events: [EKEvent] = []
        // EventKit only searches up to four years at a time.
        var cursor = from
        while cursor < to {
            let chunkEnd = min(to, Calendar.current.date(byAdding: .year, value: 3, to: cursor)!)
            events += store.events(matching: store.predicateForEvents(withStart: cursor, end: chunkEnd, calendars: cals))
            cursor = chunkEnd
        }
        if let q = nonEmpty(p, "query") {
            events = events.filter { e in
                (e.title ?? "").localizedCaseInsensitiveContains(q) || (e.location ?? "").localizedCaseInsensitiveContains(q) || (e.notes ?? "").localizedCaseInsensitiveContains(q)
            }
        }
        events.sort { $0.startDate < $1.startDate }
        let total = events.count
        let offset = max(0, int(p, "offset") ?? 0)
        let limit = max(1, min(500, int(p, "limit") ?? 100))
        return ["total": total, "offset": offset, "items": Array(events.dropFirst(offset).prefix(limit)).map { eventJSON($0) }] as JSON
    }

    static func event(_ id: String, occurrence: JSON?) throws -> EKEvent {
        guard let base = store.event(withIdentifier: id) else {
            throw HelperError("NOT_FOUND", "No event with id \(id). Use calendar_find_events to get current ids.")
        }
        guard let occ = occurrence, base.hasRecurrenceRules else { return base }
        let day = try wallDate(occ)
        let start = Calendar.current.startOfDay(for: day)
        let end = Calendar.current.date(byAdding: .day, value: 1, to: start)!
        let matches = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: base.calendar.map { [$0] }))
        if let m = matches.first(where: { $0.eventIdentifier == id }) { return m }
        throw HelperError("NOT_FOUND", "That repeating event has no occurrence on \(dayFormatter.string(from: day)).")
    }

    static func applyEventFields(_ e: EKEvent, _ j: JSON) throws {
        if let t = str(j, "title") { e.title = t }
        if has(j, "notes") { e.notes = isNull(j, "notes") ? nil : str(j, "notes") }
        if has(j, "location") { e.location = isNull(j, "location") ? nil : str(j, "location") }
        if has(j, "url") {
            if let u = nonEmpty(j, "url") { e.url = URL(string: u) } else { e.url = nil }
        }
        if has(j, "calendar") || has(j, "calendar_id") {
            if let c = try oneCalendar(.event, j, idKey: "calendar_id", nameKey: "calendar") { e.calendar = c }
        }
        if let ad = bool(j, "all_day") { e.isAllDay = ad }
        if let s = dict(j, "start") {
            let start = try wallDate(s)
            let duration = (e.endDate != nil && e.startDate != nil) ? e.endDate.timeIntervalSince(e.startDate) : 3600
            e.startDate = start
            if dict(j, "end") == nil { e.endDate = start.addingTimeInterval(max(duration, e.isAllDay ? 86400 : 900)) }
            if int(s, "H") == nil && bool(j, "all_day") == nil { e.isAllDay = true }
        }
        if let en = dict(j, "end") {
            var end = try wallDate(en)
            if int(en, "H") == nil { end = Calendar.current.date(byAdding: .day, value: 1, to: end)!.addingTimeInterval(-1) }
            e.endDate = end
        }
        if e.endDate != nil && e.startDate != nil && e.endDate < e.startDate {
            throw HelperError("BAD_PARAMS", "The event ends before it starts.")
        }
        if has(j, "alarms") {
            for a in e.alarms ?? [] { e.removeAlarm(a) }
            for a in try alarms((j["alarms"] as? [Any]) ?? []) { e.addAlarm(a) }
        }
        if has(j, "recurrence") {
            for r in e.recurrenceRules ?? [] { e.removeRecurrenceRule(r) }
            if let rj = dict(j, "recurrence") { e.addRecurrenceRule(try recurrence(rj)) }
        }
    }

    static func createEvent(_ p: JSON) throws -> Any {
        try ensure(.event)
        guard nonEmpty(p, "title") != nil, dict(p, "start") != nil else { throw HelperError("BAD_PARAMS", "title and start are required.") }
        let e = EKEvent(eventStore: store)
        if let c = try oneCalendar(.event, p, idKey: "calendar_id", nameKey: "calendar") { e.calendar = c }
        else {
            guard let def = store.defaultCalendarForNewEvents else { throw HelperError("NO_DEFAULT_CALENDAR", "No default calendar. Pass a calendar name.") }
            e.calendar = def
        }
        try applyEventFields(e, p)
        do { try store.save(e, span: .thisEvent, commit: true) } catch {
            store.reset()
            throw HelperError("SAVE_FAILED", error.localizedDescription)
        }
        return eventJSON(e)
    }

    static func span(_ p: JSON) -> EKSpan { (str(p, "span") ?? "this") == "future" ? .futureEvents : .thisEvent }

    static func updateEvent(_ p: JSON) throws -> Any {
        try ensure(.event)
        let e = try event(try required(p, "id"), occurrence: dict(p, "occurrence_date"))
        try applyEventFields(e, p)
        do { try store.save(e, span: span(p), commit: true) } catch {
            store.reset()
            throw HelperError("SAVE_FAILED", error.localizedDescription)
        }
        return eventJSON(e)
    }

    static func deleteEvent(_ p: JSON) throws -> Any {
        try ensure(.event)
        let e = try event(try required(p, "id"), occurrence: dict(p, "occurrence_date"))
        let info = eventJSON(e)
        try store.remove(e, span: span(p), commit: true)
        return ["deleted": info]
    }
}

// MARK: - Contacts

final class ContactBook {
    static let store = CNContactStore()
    static var index: [String: String]? = nil   // normalized handle -> display name
    static var indexBuilt = Date.distantPast

    static func statusString() -> String {
        switch CNContactStore.authorizationStatus(for: .contacts).rawValue {
        case 0: return "not_determined"
        case 1: return "restricted"
        case 2: return "denied"
        case 3: return "granted"
        case 4: return "limited"
        default: return "unknown"
        }
    }

    static func request() -> JSON {
        let sem = DispatchSemaphore(value: 0)
        var granted = false
        var message: String? = nil
        store.requestAccess(for: .contacts) { g, e in granted = g; message = e?.localizedDescription; sem.signal() }
        let waited = sem.wait(timeout: .now() + 180)
        return ["granted": granted, "timed_out": waited == .timedOut, "status": statusString(), "message": orNull(message)]
    }

    static func ensure() throws {
        let st = statusString()
        if st == "granted" || st == "limited" { return }
        if st == "not_determined", (request()["granted"] as? Bool) == true { return }
        throw HelperError("PERMISSION_DENIED", "Contacts access is not granted to Orchard Helper. Open System Settings > Privacy & Security > Contacts and turn on Orchard Helper.")
    }

    static var keys: [CNKeyDescriptor] {
        let base: [CNKeyDescriptor] = [CNContactIdentifierKey, CNContactGivenNameKey, CNContactFamilyNameKey, CNContactMiddleNameKey,
                CNContactNicknameKey, CNContactOrganizationNameKey, CNContactJobTitleKey,
                CNContactPhoneNumbersKey, CNContactEmailAddressesKey, CNContactBirthdayKey] as [CNKeyDescriptor]
        return base + [CNContactFormatter.descriptorForRequiredKeys(for: .fullName)]
    }

    static func name(_ c: CNContact) -> String {
        if let n = CNContactFormatter.string(from: c, style: .fullName), !n.isEmpty { return n }
        if !c.nickname.isEmpty { return c.nickname }
        if !c.organizationName.isEmpty { return c.organizationName }
        return c.phoneNumbers.first?.value.stringValue ?? c.emailAddresses.first.map { String($0.value) } ?? "Unknown"
    }

    static func label(_ l: String?) -> Any {
        guard let l = l else { return NSNull() }
        return CNLabeledValue<NSString>.localizedString(forLabel: l)
    }

    static func json(_ c: CNContact) -> JSON {
        var out: JSON = [
            "id": c.identifier,
            "name": name(c),
            "nickname": blankAsNull(c.nickname),
            "organization": blankAsNull(c.organizationName),
            "job_title": blankAsNull(c.jobTitle),
            "phones": c.phoneNumbers.map { ["label": label($0.label), "value": $0.value.stringValue] },
            "emails": c.emailAddresses.map { ["label": label($0.label), "value": String($0.value)] },
        ]
        if let b = c.birthday, let m = b.month, let d = b.day {
            out["birthday"] = b.year.map { String(format: "%04d-%02d-%02d", $0, m, d) } ?? String(format: "--%02d-%02d", m, d)
        }
        return out
    }

    static func digits(_ s: String) -> String { String(s.unicodeScalars.filter { CharacterSet.decimalDigits.contains($0) }) }

    static func phoneKey(_ s: String) -> String? {
        let d = digits(s)
        if d.count < 5 { return nil }
        return d.count > 11 ? String(d.suffix(11)) : d
    }

    static func search(_ p: JSON) throws -> Any {
        try ensure()
        let q = try required(p, "query")
        let limit = max(1, min(100, int(p, "limit") ?? 20))
        var found: [String: CNContact] = [:]
        var order: [String] = []
        func add(_ cs: [CNContact]) { for c in cs where found[c.identifier] == nil { found[c.identifier] = c; order.append(c.identifier) } }
        add((try? store.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: q), keysToFetch: keys)) ?? [])
        if q.contains("@") {
            add((try? store.unifiedContacts(matching: CNContact.predicateForContacts(matchingEmailAddress: q), keysToFetch: keys)) ?? [])
        }
        if digits(q).count >= 5 {
            add((try? store.unifiedContacts(matching: CNContact.predicateForContacts(matching: CNPhoneNumber(stringValue: q)), keysToFetch: keys)) ?? [])
        }
        if found.isEmpty {
            // Fallback: substring match over nickname, organization and every name part (catches partial Chinese names).
            let req = CNContactFetchRequest(keysToFetch: keys)
            try store.enumerateContacts(with: req) { c, stop in
                let hay = [name(c), c.nickname, c.organizationName, c.givenName, c.familyName].joined(separator: " ")
                if hay.localizedCaseInsensitiveContains(q) { add([c]) }
                if found.count >= limit { stop.pointee = true }
            }
        }
        return order.prefix(limit).compactMap { found[$0] }.map { json($0) }
    }

    static let indexLock = NSLock()
    static func buildIndex() -> [String: String] {
        indexLock.lock(); defer { indexLock.unlock() }
        if let idx = index, Date().timeIntervalSince(indexBuilt) < 600 { return idx }
        var idx: [String: String] = [:]
        let st = statusString()
        if st == "granted" || st == "limited" {
            let req = CNContactFetchRequest(keysToFetch: keys)
            try? store.enumerateContacts(with: req) { c, _ in
                let n = name(c)
                for ph in c.phoneNumbers { if let k = phoneKey(ph.value.stringValue) { idx[k] = n } }
                for em in c.emailAddresses { idx[String(em.value).lowercased()] = n }
            }
        }
        index = idx
        indexBuilt = Date()
        return idx
    }

    static func nameFor(handle: String) -> String? {
        let idx = buildIndex()
        if handle.contains("@") { return idx[handle.lowercased()] }
        if let k = phoneKey(handle), let n = idx[k] { return n }
        return nil
    }

    static func resolve(_ p: JSON) throws -> Any {
        let handles = strings(p, "handles") ?? []
        var out: JSON = [:]
        for h in handles { out[h] = orNull(nameFor(handle: h)) }
        return out
    }
}

// MARK: - SQLite

let SQLITE_TRANSIENT_ = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

final class SQLiteDB {
    var db: OpaquePointer?
    let path: String

    init(path: String, label: String) throws {
        self.path = path
        guard FileManager.default.fileExists(atPath: path) else {
            throw HelperError("NOT_FOUND", "\(label) database not found at \(path).")
        }
        let rc = sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil)
        if rc != SQLITE_OK {
            sqlite3_close(db)
            db = nil
            throw SQLiteDB.accessError(label, rc)
        }
        sqlite3_busy_timeout(db, 3000)
        // Probe now so a missing Full Disk Access grant surfaces immediately.
        do { _ = try query("SELECT 1 FROM sqlite_master LIMIT 1", label: label) }
        catch { sqlite3_close(db); db = nil; throw error }
    }

    deinit { if db != nil { sqlite3_close(db) } }

    static func accessError(_ label: String, _ rc: Int32) -> HelperError {
        if rc == SQLITE_CANTOPEN || rc == SQLITE_AUTH || rc == SQLITE_PERM {
            return HelperError("FULL_DISK_ACCESS_REQUIRED",
                "Reading \(label) needs Full Disk Access for Orchard Helper. Open System Settings > Privacy & Security > Full Disk Access, click +, and add the Orchard Helper binary (apple_status shows its path).")
        }
        return HelperError("SQLITE_ERROR", "Could not open \(label) (sqlite code \(rc)).")
    }

    func query(_ sql: String, _ args: [Any?] = [], label: String = "database") throws -> [JSON] {
        var stmt: OpaquePointer?
        let rc = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        guard rc == SQLITE_OK else {
            let msg = String(cString: sqlite3_errmsg(db))
            if msg.contains("authorization denied") || msg.contains("unable to open") { throw SQLiteDB.accessError(label, SQLITE_AUTH) }
            throw HelperError("SQLITE_ERROR", "\(msg)")
        }
        defer { sqlite3_finalize(stmt) }
        for (i, a) in args.enumerated() {
            let idx = Int32(i + 1)
            switch a {
            case nil: sqlite3_bind_null(stmt, idx)
            case let v as Int: sqlite3_bind_int64(stmt, idx, Int64(v))
            case let v as Int64: sqlite3_bind_int64(stmt, idx, v)
            case let v as Double: sqlite3_bind_double(stmt, idx, v)
            case let v as String: sqlite3_bind_text(stmt, idx, v, -1, SQLITE_TRANSIENT_)
            default: sqlite3_bind_null(stmt, idx)
            }
        }
        var rows: [JSON] = []
        while true {
            let step = sqlite3_step(stmt)
            if step == SQLITE_DONE { break }
            if step != SQLITE_ROW {
                let msg = String(cString: sqlite3_errmsg(db))
                if msg.contains("authorization denied") || msg.contains("unable to open") { throw SQLiteDB.accessError(label, SQLITE_AUTH) }
                throw HelperError("SQLITE_ERROR", msg)
            }
            var row: JSON = [:]
            let n = sqlite3_column_count(stmt)
            for c in 0..<n {
                let name = String(cString: sqlite3_column_name(stmt, c))
                switch sqlite3_column_type(stmt, c) {
                case SQLITE_INTEGER: row[name] = Int(sqlite3_column_int64(stmt, c))
                case SQLITE_FLOAT: row[name] = sqlite3_column_double(stmt, c)
                case SQLITE_TEXT: row[name] = String(cString: sqlite3_column_text(stmt, c))
                case SQLITE_BLOB:
                    let len = Int(sqlite3_column_bytes(stmt, c))
                    if let ptr = sqlite3_column_blob(stmt, c), len > 0 { row[name] = Data(bytes: ptr, count: len) }
                    else { row[name] = Data() }
                default: row[name] = NSNull()
                }
            }
            rows.append(row)
        }
        return rows
    }

    func columns(_ table: String) -> Set<String> {
        let rows = (try? query("PRAGMA table_info(\(table))")) ?? []
        return Set(rows.compactMap { $0["name"] as? String })
    }
}

func likeEscape(_ s: String) -> String {
    return s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "%", with: "\\%").replacingOccurrences(of: "_", with: "\\_")
}

// MARK: - Messages (chat.db)

final class Messages {
    static let path = NSHomeDirectory() + "/Library/Messages/chat.db"
    static var cached: SQLiteDB?

    static func db() throws -> SQLiteDB {
        if let c = cached { return c }
        let d = try SQLiteDB(path: path, label: "Messages")
        cached = d
        return d
    }
    static func run(_ sql: String, _ args: [Any?] = []) throws -> [JSON] {
        do { return try db().query(sql, args, label: "Messages") }
        catch let e as HelperError where e.code == "SQLITE_ERROR" {
            cached = nil  // reopen once in case the file was swapped
            return try db().query(sql, args, label: "Messages")
        }
    }

    static let appleEpoch: Double = 978307200
    static func date(_ raw: Any?) -> Date? {
        guard let v = (raw as? Int).map({ Double($0) }) ?? (raw as? Double), v != 0 else { return nil }
        let secs = v > 1e11 ? v / 1e9 : v
        return Date(timeIntervalSince1970: secs + appleEpoch)
    }
    static func appleNanos(_ d: Date) -> Int { Int((d.timeIntervalSince1970 - appleEpoch) * 1e9) }

    // Decodes the typedstream NSAttributedString in message.attributedBody without
    // NSUnarchiver (which raises uncatchable exceptions on malformed blobs).
    static func decodeAttributedBody(_ data: Data) -> String? {
        let bytes = [UInt8](data)
        let marker = Array("NSString".utf8)
        guard bytes.count > marker.count + 4 else { return nil }
        var start = -1
        var i = 0
        while i <= bytes.count - marker.count {
            if bytes[i] == marker[0] && Array(bytes[i..<(i + marker.count)]) == marker { start = i + marker.count; break }
            i += 1
        }
        guard start > 0 else { return nil }
        var p = start
        while p < bytes.count && bytes[p] != 0x2B { p += 1 }   // '+'
        p += 1
        guard p < bytes.count else { return nil }
        var length = 0
        let lb = bytes[p]
        if lb == 0x81, p + 2 < bytes.count {
            length = Int(bytes[p + 1]) | (Int(bytes[p + 2]) << 8); p += 3
        } else if lb == 0x82, p + 4 < bytes.count {
            length = Int(bytes[p + 1]) | (Int(bytes[p + 2]) << 8) | (Int(bytes[p + 3]) << 16) | (Int(bytes[p + 4]) << 24); p += 5
        } else {
            length = Int(lb); p += 1
        }
        guard length > 0, p + length <= bytes.count else { return nil }
        return String(bytes: bytes[p..<(p + length)], encoding: .utf8)
    }

    static func text(_ row: JSON) -> String {
        if let t = row["text"] as? String, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return t }
        if let b = row["attributedBody"] as? Data, let t = decodeAttributedBody(b) { return t }
        return ""
    }

    static func displayName(_ handle: String?) -> Any {
        guard let h = handle, !h.isEmpty else { return NSNull() }
        return orNull(ContactBook.nameFor(handle: h))
    }

    static func participants(_ chatRowId: Int) throws -> [JSON] {
        let rows = try run("SELECT h.id AS handle, h.service FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = ?", [chatRowId])
        return rows.map { r in
            let h = r["handle"] as? String ?? ""
            return ["handle": h, "name": displayName(h), "service": orNull(r["service"])]
        }
    }

    static func attachments(_ messageRowId: Int) -> [JSON] {
        let rows = (try? run("SELECT a.filename, a.mime_type, a.transfer_name, a.total_bytes FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id WHERE maj.message_id = ?", [messageRowId])) ?? []
        return rows.map { r in
            var path = r["filename"] as? String ?? ""
            if path.hasPrefix("~") { path = NSHomeDirectory() + path.dropFirst() }
            return ["name": orNull(r["transfer_name"]), "mime": orNull(r["mime_type"]), "path": blankAsNull(path), "bytes": orNull(r["total_bytes"])]
        }
    }

    static func messageJSON(_ r: JSON) -> JSON {
        let rowid = r["ROWID"] as? Int ?? 0
        let fromMe = (r["is_from_me"] as? Int ?? 0) == 1
        let handle = r["sender"] as? String
        var out: JSON = [
            "id": rowid,
            "date": iso(date(r["date"])),
            "from_me": fromMe,
            "sender": fromMe ? "me" as Any : orNull(handle),
            "sender_name": fromMe ? "me" as Any : displayName(handle),
            "text": text(r),
            "read": (r["is_read"] as? Int ?? 0) == 1,
            "service": orNull(r["service"]),
        ]
        if (r["cache_has_attachments"] as? Int ?? 0) == 1 { out["attachments"] = attachments(rowid) }
        if let cid = r["chat_id"] as? Int { out["chat_id"] = cid }
        return out
    }

    static func chatJSON(_ r: JSON) throws -> JSON {
        let cid = r["chat_rowid"] as? Int ?? 0
        let parts = try participants(cid)
        let display = (r["display_name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let title: String = display ?? parts.map { ($0["name"] as? String) ?? ($0["handle"] as? String ?? "") }.joined(separator: ", ")
        return [
            "chat_id": cid,
            "guid": orNull(r["guid"]),
            "title": title.isEmpty ? (r["chat_identifier"] as? String ?? "") : title,
            "is_group": parts.count > 1,
            "participants": parts,
            "service": orNull(r["service_name"]),
            "unread": r["unread"] ?? 0,
            "last_message": [
                "date": iso(date(r["last_date"])),
                "from_me": (r["is_from_me"] as? Int ?? 0) == 1,
                "text": text(r),
            ] as JSON,
        ]
    }

    static func chats(_ p: JSON) throws -> Any {
        let limit = max(1, min(100, int(p, "limit") ?? 20))
        let offset = max(0, int(p, "offset") ?? 0)
        let unreadOnly = bool(p, "unread_only") ?? false
        var sql = """
        SELECT c.ROWID AS chat_rowid, c.guid, c.chat_identifier, c.display_name, c.service_name,
               m.text, m.attributedBody, m.date AS last_date, m.is_from_me,
               (SELECT COUNT(*) FROM chat_message_join j2 JOIN message m2 ON m2.ROWID = j2.message_id
                 WHERE j2.chat_id = c.ROWID AND m2.is_read = 0 AND m2.is_from_me = 0
                   AND m2.item_type = 0 AND m2.associated_message_type = 0) AS unread
        FROM chat c
        JOIN message m ON m.ROWID = (SELECT MAX(message_id) FROM chat_message_join WHERE chat_id = c.ROWID)
        """
        if unreadOnly { sql += " WHERE unread > 0" }
        sql += " ORDER BY m.date DESC LIMIT ? OFFSET ?"
        let rows = try run(sql, [limit, offset])
        return try rows.map { try chatJSON($0) }
    }

    static func chatIdsForHandles(_ handles: [String]) throws -> [Int] {
        var ids: [Int] = []
        let all = try run("SELECT ROWID, id FROM handle")
        var handleRows: [Int] = []
        for h in handles {
            let wantEmail = h.contains("@") ? h.lowercased() : nil
            let wantPhone = h.contains("@") ? nil : ContactBook.phoneKey(h)
            for r in all {
                guard let hid = r["id"] as? String, let rid = r["ROWID"] as? Int else { continue }
                if let e = wantEmail, hid.lowercased() == e { handleRows.append(rid) }
                else if let ph = wantPhone, ContactBook.phoneKey(hid) == ph { handleRows.append(rid) }
            }
        }
        if handleRows.isEmpty { return [] }
        let list = handleRows.map(String.init).joined(separator: ",")
        let rows = try run("""
            SELECT chj.chat_id AS cid, (SELECT COUNT(*) FROM chat_handle_join x WHERE x.chat_id = chj.chat_id) AS n,
                   (SELECT MAX(message_id) FROM chat_message_join WHERE chat_id = chj.chat_id) AS last
            FROM chat_handle_join chj WHERE chj.handle_id IN (\(list)) GROUP BY chj.chat_id ORDER BY n ASC, last DESC
        """)
        for r in rows { if let c = r["cid"] as? Int { ids.append(c) } }
        return ids
    }

    // Find chats for a person: handles from the caller (resolved via Contacts on the Node side).
    static func findChats(_ p: JSON) throws -> Any {
        let ids = try chatIdsForHandles(strings(p, "handles") ?? [])
        if ids.isEmpty { return [] }
        let list = ids.map(String.init).joined(separator: ",")
        let rows = try run("""
            SELECT c.ROWID AS chat_rowid, c.guid, c.chat_identifier, c.display_name, c.service_name,
                   m.text, m.attributedBody, m.date AS last_date, m.is_from_me, 0 AS unread
            FROM chat c JOIN message m ON m.ROWID = (SELECT MAX(message_id) FROM chat_message_join WHERE chat_id = c.ROWID)
            WHERE c.ROWID IN (\(list)) ORDER BY m.date DESC
        """)
        return try rows.map { try chatJSON($0) }
    }

    static func history(_ p: JSON) throws -> Any {
        guard let chatId = int(p, "chat_id") else { throw HelperError("BAD_PARAMS", "chat_id is required.") }
        let limit = max(1, min(500, int(p, "limit") ?? 50))
        var sql = """
        SELECT m.ROWID, m.text, m.attributedBody, m.date, m.is_from_me, m.is_read, m.cache_has_attachments, m.service, h.id AS sender
        FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE cmj.chat_id = ? AND m.associated_message_type = 0 AND m.item_type = 0
        """
        var args: [Any?] = [chatId]
        if let s = dict(p, "since") { sql += " AND m.date >= ?"; args.append(appleNanos(try wallDate(s))) }
        if let b = dict(p, "before") { sql += " AND m.date < ?"; args.append(appleNanos(try wallDate(b))) }
        sql += " ORDER BY m.date DESC LIMIT ?"
        args.append(limit)
        let rows = try run(sql, args)
        let chatRows = try run("SELECT c.ROWID AS chat_rowid, c.guid, c.chat_identifier, c.display_name, c.service_name, NULL AS text, NULL AS attributedBody, NULL AS last_date, 0 AS is_from_me, 0 AS unread FROM chat c WHERE c.ROWID = ?", [chatId])
        guard let chatRow = chatRows.first else { throw HelperError("NOT_FOUND", "No chat with id \(chatId).") }
        var chat = try chatJSON(chatRow)
        chat.removeValue(forKey: "last_message")
        return ["chat": chat, "messages": rows.reversed().map { messageJSON($0) }] as JSON
    }

    static func search(_ p: JSON) throws -> Any {
        let q = try required(p, "query")
        let limit = max(1, min(200, int(p, "limit") ?? 30))
        let pattern = "%" + likeEscape(q) + "%"
        var sql = """
        SELECT m.ROWID, m.text, m.attributedBody, m.date, m.is_from_me, m.is_read, m.cache_has_attachments, m.service,
               h.id AS sender, cmj.chat_id
        FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
        LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        WHERE m.associated_message_type = 0 AND (m.text LIKE ? ESCAPE '\\' OR CAST(m.attributedBody AS TEXT) LIKE ? ESCAPE '\\')
        """
        var args: [Any?] = [pattern, pattern]
        if let s = dict(p, "since") { sql += " AND m.date >= ?"; args.append(appleNanos(try wallDate(s))) }
        if let cid = int(p, "chat_id") { sql += " AND cmj.chat_id = ?"; args.append(cid) }
        sql += " ORDER BY m.date DESC LIMIT ?"
        args.append(limit)
        let rows = try run(sql, args)
        var titles: [Int: String] = [:]
        return try rows.map { r -> JSON in
            var m = messageJSON(r)
            if let cid = r["chat_id"] as? Int {
                if titles[cid] == nil {
                    let cr = try run("SELECT c.ROWID AS chat_rowid, c.guid, c.chat_identifier, c.display_name, c.service_name, NULL AS text, NULL AS attributedBody, NULL AS last_date, 0 AS is_from_me, 0 AS unread FROM chat c WHERE c.ROWID = ?", [cid])
                    titles[cid] = try cr.first.map { try chatJSON($0)["title"] as? String ?? "" } ?? ""
                }
                m["chat_title"] = titles[cid] ?? ""
            }
            return m
        }
    }
}

// MARK: - Mail (Envelope Index)

final class MailIndex {
    static var cached: SQLiteDB?
    static var cols: Set<String> = []

    static func locate() -> String? {
        let base = NSHomeDirectory() + "/Library/Mail"
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: base) else { return nil }
        let versions = entries.filter { $0.hasPrefix("V") && Int($0.dropFirst()) != nil }.sorted { Int($0.dropFirst())! > Int($1.dropFirst())! }
        for v in versions {
            let p = "\(base)/\(v)/MailData/Envelope Index"
            if FileManager.default.fileExists(atPath: p) { return p }
        }
        return nil
    }

    static func db() throws -> SQLiteDB {
        if let c = cached { return c }
        guard let path = locate() else {
            // Without Full Disk Access the Mail folder itself is unreadable.
            if (try? FileManager.default.contentsOfDirectory(atPath: NSHomeDirectory() + "/Library/Mail")) == nil {
                throw SQLiteDB.accessError("Mail", SQLITE_AUTH)
            }
            throw HelperError("NOT_FOUND", "Mail's message index was not found. Open Mail once so it builds its index.")
        }
        let d = try SQLiteDB(path: path, label: "Mail")
        cols = d.columns("messages")
        cached = d
        return d
    }
    static func run(_ sql: String, _ args: [Any?] = []) throws -> [JSON] {
        do { return try db().query(sql, args, label: "Mail") }
        catch let e as HelperError where e.code == "SQLITE_ERROR" {
            cached = nil
            return try db().query(sql, args, label: "Mail")
        }
    }

    static func date(_ raw: Any?) -> Date? {
        guard let v = (raw as? Int).map({ Double($0) }) ?? (raw as? Double), v > 0 else { return nil }
        return Date(timeIntervalSince1970: v < 1.2e9 ? v + 978307200 : v)
    }
    static func unixSeconds(_ d: Date) -> Int { Int(d.timeIntervalSince1970) }

    static func mailboxInfo(_ url: String) -> JSON {
        guard let u = URL(string: url) else { return ["account_id": NSNull(), "mailbox": url] }
        var path = u.path
        if path.hasPrefix("/") { path.removeFirst() }
        let name = path.removingPercentEncoding ?? path
        return ["account_id": orNull(u.host), "mailbox": name, "url": url]
    }

    static func recipients(_ rowid: Int) -> JSON {
        let rows = (try? run("SELECT r.type, a.address, a.comment FROM recipients r JOIN addresses a ON a.ROWID = r.address WHERE r.message = ? ORDER BY r.type, r.position", [rowid]))
            ?? (try? run("SELECT r.type, a.address, a.comment FROM recipients r JOIN addresses a ON a.ROWID = r.address WHERE r.message = ?", [rowid])) ?? []
        var to: [String] = [], cc: [String] = []
        for r in rows {
            let addr = r["address"] as? String ?? ""
            let name = (r["comment"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let s = name.map { "\($0) <\(addr)>" } ?? addr
            if (r["type"] as? Int ?? 0) == 1 { cc.append(s) } else { to.append(s) }
        }
        return ["to": to, "cc": cc]
    }

    static func messageJSON(_ r: JSON, withRecipients: Bool) -> JSON {
        let rowid = r["ROWID"] as? Int ?? 0
        let addr = r["address"] as? String ?? ""
        let name = (r["comment"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        var out: JSON = [
            "id": rowid,
            "subject": r["subject"] ?? "",
            "from": name.map { "\($0) <\(addr)>" } ?? addr,
            "from_address": addr,
            "from_name": orNull(name ?? ContactBook.nameFor(handle: addr)),
            "date": iso(date(r["date_received"])),
            "read": (r["read"] as? Int ?? 0) == 1,
            "flagged": (r["flagged"] as? Int ?? 0) == 1,
            "preview": orNull(r["summary"]),
        ]
        if let url = r["mailbox_url"] as? String { out["mailbox"] = mailboxInfo(url) }
        if withRecipients { out.merge(recipients(rowid)) { a, _ in a } }
        return out
    }

    // params: query, from, mailbox (inbox|sent|flagged|all|<name>), account_id, unread_only, flagged_only, since{}, until{}, limit, offset
    static func search(_ p: JSON) throws -> Any {
        _ = try db()
        let flaggedCol = cols.contains("flagged") ? "m.flagged" : "0"
        var sql = """
        SELECT m.ROWID, s.subject, a.address, a.comment, m.date_received, m.read, \(flaggedCol) AS flagged, mb.url AS mailbox_url, sm.summary
        FROM messages m
        LEFT JOIN subjects s ON s.ROWID = m.subject
        LEFT JOIN addresses a ON a.ROWID = m.sender
        LEFT JOIN mailboxes mb ON mb.ROWID = m.mailbox
        LEFT JOIN summaries sm ON sm.ROWID = m.summary
        WHERE m.deleted = 0
        """
        var args: [Any?] = []
        let box = (str(p, "mailbox") ?? "inbox").lowercased()
        let hasLabels = !(try run("SELECT name FROM sqlite_master WHERE type='table' AND name='labels'")).isEmpty
        switch box {
        case "inbox":
            sql += " AND (LOWER(mb.url) LIKE '%/inbox'"
            if hasLabels { sql += " OR m.ROWID IN (SELECT l.message_id FROM labels l JOIN mailboxes lb ON lb.ROWID = l.mailbox_id WHERE LOWER(lb.url) LIKE '%/inbox')" }
            sql += ")"
        case "sent":
            sql += " AND (LOWER(mb.url) LIKE '%sent%' OR mb.url LIKE '%E5%B7%B2%E5%8F%91%E9%80%81%')"  // 已发送
        case "all":
            sql += " AND LOWER(mb.url) NOT LIKE '%trash%' AND LOWER(mb.url) NOT LIKE '%junk%' AND LOWER(mb.url) NOT LIKE '%deleted%' AND LOWER(mb.url) NOT LIKE '%spam%'"
        case "flagged":
            sql += " AND \(flaggedCol) = 1"
        default:
            sql += " AND LOWER(mb.url) LIKE ? ESCAPE '\\'"
            let enc = (str(p, "mailbox") ?? "").addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""
            args.append("%/" + likeEscape(enc.lowercased()))
        }
        if let acct = nonEmpty(p, "account_id") { sql += " AND mb.url LIKE ? ESCAPE '\\'"; args.append("%://" + likeEscape(acct) + "/%") }
        if bool(p, "unread_only") == true { sql += " AND m.read = 0" }
        if bool(p, "flagged_only") == true { sql += " AND \(flaggedCol) = 1" }
        if let q = nonEmpty(p, "query") {
            let pat = "%" + likeEscape(q) + "%"
            sql += " AND (s.subject LIKE ? ESCAPE '\\' OR a.address LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\' OR sm.summary LIKE ? ESCAPE '\\')"
            args += [pat, pat, pat, pat]
        }
        if let f = nonEmpty(p, "from") {
            let pat = "%" + likeEscape(f) + "%"
            sql += " AND (a.address LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\')"
            args += [pat, pat]
        }
        if let s = dict(p, "since") { sql += " AND m.date_received >= ?"; args.append(unixSeconds(try wallDate(s))) }
        if let u = dict(p, "until") {
            var d = try wallDate(u)
            if int(u, "H") == nil { d = Calendar.current.date(byAdding: .day, value: 1, to: d)! }
            sql += " AND m.date_received < ?"; args.append(unixSeconds(d))
        }
        let limit = max(1, min(200, int(p, "limit") ?? 25))
        let offset = max(0, int(p, "offset") ?? 0)
        sql += " GROUP BY m.ROWID ORDER BY m.date_received DESC LIMIT ? OFFSET ?"
        args += [limit + 1, offset]
        let rows = try run(sql, args)
        let hasMore = rows.count > limit
        return ["offset": offset, "has_more": hasMore, "items": rows.prefix(limit).map { messageJSON($0, withRecipients: false) }] as JSON
    }

    static func get(_ p: JSON) throws -> Any {
        _ = try db()
        guard let id = int(p, "id") else { throw HelperError("BAD_PARAMS", "id is required.") }
        let flaggedCol = cols.contains("flagged") ? "m.flagged" : "0"
        let rows = try run("""
            SELECT m.ROWID, s.subject, a.address, a.comment, m.date_received, m.read, \(flaggedCol) AS flagged, mb.url AS mailbox_url, sm.summary
            FROM messages m LEFT JOIN subjects s ON s.ROWID = m.subject LEFT JOIN addresses a ON a.ROWID = m.sender
            LEFT JOIN mailboxes mb ON mb.ROWID = m.mailbox LEFT JOIN summaries sm ON sm.ROWID = m.summary WHERE m.ROWID = ?
        """, [id])
        guard let r = rows.first else { throw HelperError("NOT_FOUND", "No email with id \(id).") }
        return messageJSON(r, withRecipients: true)
    }

    static func mailboxes(_ p: JSON) throws -> Any {
        let rows = try run("SELECT url, total_count, unread_count FROM mailboxes WHERE total_count > 0 ORDER BY url")
        return rows.map { r -> JSON in
            var j = mailboxInfo(r["url"] as? String ?? "")
            j["total"] = r["total_count"] ?? 0
            j["unread"] = r["unread_count"] ?? 0
            return j
        }
    }
}

// MARK: - Apple Events

final class OSA {
    static func run(_ p: JSON) throws -> Any {
        let script = try required(p, "script")
        let lang = (str(p, "lang") ?? "JavaScript") == "AppleScript" ? "AppleScript" : "JavaScript"
        let args = strings(p, "args") ?? []
        let timeout = Double(max(1, min(600, int(p, "timeout_s") ?? 60)))
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = ["-l", lang, "-e", script] + args
        let out = Pipe(), err = Pipe()
        proc.standardOutput = out
        proc.standardError = err
        proc.standardInput = FileHandle.nullDevice
        var outData = Data(), errData = Data()
        let group = DispatchGroup()
        group.enter(); DispatchQueue.global().async { outData = out.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        group.enter(); DispatchQueue.global().async { errData = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        try proc.run()
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { proc.waitUntilExit(); finished.signal() }
        if finished.wait(timeout: .now() + timeout) == .timedOut {
            proc.terminate()
            _ = group.wait(timeout: .now() + 2)
            throw HelperError("TIMEOUT", "The \(str(p, "app") ?? "app") script did not finish within \(Int(timeout)) seconds. The app may be busy or waiting for a dialog.")
        }
        _ = group.wait(timeout: .now() + 5)
        let stdout = String(data: outData, encoding: .utf8)?.trimmingCharacters(in: .newlines) ?? ""
        let stderr = String(data: errData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if proc.terminationStatus != 0 {
            if stderr.contains("-1743") || stderr.contains("Not authorized") || stderr.contains("not allowed assistive") {
                let app = str(p, "app") ?? "the app"
                throw HelperError("AUTOMATION_DENIED", "Orchard Helper is not allowed to control \(app). Open System Settings > Privacy & Security > Automation, expand Orchard Helper, and turn on \(app).")
            }
            if stderr.contains("-600") || stderr.contains("isn't running") {
                throw HelperError("APP_NOT_RUNNING", "\(str(p, "app") ?? "The app") could not be reached. Open it once and try again.")
            }
            throw HelperError("SCRIPT_ERROR", stderr.isEmpty ? "Script failed with status \(proc.terminationStatus)." : stderr)
        }
        return stdout
    }
}

// MARK: - Permissions

final class Permissions {
    static let apps: [(String, String)] = [("Mail", "com.apple.mail"), ("Notes", "com.apple.Notes"), ("Messages", "com.apple.MobileSMS")]

    static func automation(_ bundleID: String, ask: Bool) -> String {
        var addr = AEAddressDesc()
        let bytes = Array(bundleID.utf8)
        let rc = bytes.withUnsafeBufferPointer { buf in
            AECreateDesc(DescType(fourCC("bund")), buf.baseAddress, buf.count, &addr)
        }
        guard rc == 0 else { return "unknown" }
        defer { AEDisposeDesc(&addr) }
        let st = AEDeterminePermissionToAutomateTarget(&addr, AEEventClass(fourCC("****")), AEEventID(fourCC("****")), ask)
        switch st {
        case 0: return "granted"
        case -1743: return "denied"
        case -1744: return "not_determined"
        case -600: return "app_not_running"
        default: return "unknown(\(st))"
        }
    }

    static func fullDiskAccess() -> JSON {
        let chat = NSHomeDirectory() + "/Library/Messages/chat.db"
        var messages = "missing"
        if FileManager.default.fileExists(atPath: chat) {
            if let h = FileHandle(forReadingAtPath: chat) { h.closeFile(); messages = "granted" } else { messages = "denied" }
        }
        var mail = "missing"
        if let path = MailIndex.locate() {
            if let h = FileHandle(forReadingAtPath: path) { h.closeFile(); mail = "granted" } else { mail = "denied" }
        } else if (try? FileManager.default.contentsOfDirectory(atPath: NSHomeDirectory() + "/Library/Mail")) == nil,
                  FileManager.default.fileExists(atPath: NSHomeDirectory() + "/Library/Mail") {
            mail = "denied"
        }
        return ["messages_db": messages, "mail_index": mail]
    }

    static func status(_ p: JSON) throws -> Any {
        var auto: JSON = [:]
        for (name, bid) in apps { auto[name] = automation(bid, ask: false) }
        var exe = [CChar](repeating: 0, count: Int(PATH_MAX)); var size = UInt32(exe.count)
        _ = _NSGetExecutablePath(&exe, &size)
        return [
            "helper_version": HELPER_VERSION,
            "helper_path": String(cString: exe),
            "self_responsible": ProcessInfo.processInfo.environment[disclaimGuard] != nil,
            "macos": ProcessInfo.processInfo.operatingSystemVersionString,
            "reminders": EK.statusString(.reminder),
            "calendars": EK.statusString(.event),
            "contacts": ContactBook.statusString(),
            "full_disk_access": fullDiskAccess(),
            "automation": auto,
            "time_zone": TimeZone.current.identifier,
            "now": iso(Date()),
        ] as JSON
    }

    static func request(_ p: JSON) throws -> Any {
        let what = try required(p, "what")
        switch what {
        case "reminders": return ekQueue.sync { EK.request(.reminder) }
        case "calendars": return ekQueue.sync { EK.request(.event) }
        case "contacts": return contactsQueue.sync { ContactBook.request() }
        case "Mail", "Notes", "Messages":
            let bid = apps.first { $0.0 == what }!.1
            var st = automation(bid, ask: true)
            if st == "app_not_running" {
                let opener = Process()
                opener.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                opener.arguments = ["-g", "-b", bid]
                try? opener.run(); opener.waitUntilExit()
                Thread.sleep(forTimeInterval: 2.0)
                st = automation(bid, ask: true)
            }
            return ["app": what, "status": st]
        default:
            throw HelperError("BAD_PARAMS", "what must be reminders, calendars, contacts, Mail, Notes or Messages.")
        }
    }
}

// MARK: - Dispatch

let ekQueue = DispatchQueue(label: "orchard.eventkit")
let contactsQueue = DispatchQueue(label: "orchard.contacts")
let dbQueue = DispatchQueue(label: "orchard.sqlite")
let osaQueue = DispatchQueue(label: "orchard.osa", attributes: .concurrent)
let miscQueue = DispatchQueue(label: "orchard.misc", attributes: .concurrent)

typealias Handler = (JSON) throws -> Any
let routes: [String: (DispatchQueue, Handler)] = [
    "ping": (miscQueue, { _ in ["pong": true, "version": HELPER_VERSION] as JSON }),
    "system.status": (miscQueue, Permissions.status),
    "system.request": (miscQueue, Permissions.request),
    "reminders.lists": (ekQueue, EK.reminderLists),
    "reminders.find": (ekQueue, EK.findReminders),
    "reminders.get": (ekQueue, EK.getReminder),
    "reminders.create": (ekQueue, EK.createReminders),
    "reminders.update": (ekQueue, EK.updateReminder),
    "reminders.complete": (ekQueue, EK.setCompleted),
    "reminders.delete": (ekQueue, EK.deleteReminders),
    "reminders.manage_list": (ekQueue, EK.manageList),
    "calendar.calendars": (ekQueue, EK.calendarList),
    "calendar.find": (ekQueue, EK.findEvents),
    "calendar.create": (ekQueue, EK.createEvent),
    "calendar.update": (ekQueue, EK.updateEvent),
    "calendar.delete": (ekQueue, EK.deleteEvent),
    "contacts.search": (contactsQueue, ContactBook.search),
    "contacts.resolve": (contactsQueue, ContactBook.resolve),
    "messages.chats": (dbQueue, Messages.chats),
    "messages.find_chats": (dbQueue, Messages.findChats),
    "messages.history": (dbQueue, Messages.history),
    "messages.search": (dbQueue, Messages.search),
    "mail.search": (dbQueue, MailIndex.search),
    "mail.get": (dbQueue, MailIndex.get),
    "mail.mailboxes": (dbQueue, MailIndex.mailboxes),
    "osa.run": (osaQueue, OSA.run),
]

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? JSON else {
        send(["id": NSNull(), "ok": false, "error": ["code": "BAD_REQUEST", "message": "Request is not valid JSON."]])
        return
    }
    let id = orNull(obj["id"])
    let method = obj["method"] as? String ?? ""
    let params = obj["params"] as? JSON ?? [:]
    guard let route = routes[method] else {
        send(["id": id, "ok": false, "error": ["code": "UNKNOWN_METHOD", "message": "Unknown method \(method)."]])
        return
    }
    let (queue, fn) = route
    queue.async {
        do {
            let result = try autoreleasepool { try fn(params) }
            send(["id": id, "ok": true, "result": result])
        } catch let e as HelperError {
            send(["id": id, "ok": false, "error": ["code": e.code, "message": e.message]])
        } catch {
            send(["id": id, "ok": false, "error": ["code": "FAILED", "message": error.localizedDescription]])
        }
    }
}

// MARK: - Entry

reexecDisclaimingResponsibility()
setvbuf(stdout, nil, _IONBF, 0)
signal(SIGPIPE, SIG_IGN)

let argv = CommandLine.arguments
if argv.count > 1 && argv[1] == "--version" {
    print(HELPER_VERSION)
    exit(0)
}
if argv.count > 2 && argv[1] == "--call" {
    // One-shot mode for debugging: orchard-helper --call method '{"json":"params"}'
    let method = argv[2]
    let params = argv.count > 3 ? argv[3] : "{}"
    let req = "{\"id\":0,\"method\":\"\(method)\",\"params\":\(params)}"
    handle(req)
    Thread.sleep(forTimeInterval: 0.1)
    ekQueue.sync {}; contactsQueue.sync {}; dbQueue.sync {}
    osaQueue.sync(flags: .barrier) {}; miscQueue.sync(flags: .barrier) {}
    exit(0)
}

Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        handle(line)
    }
    // stdin closed: the MCP server is gone. Let in-flight work finish briefly, then exit.
    Thread.sleep(forTimeInterval: 0.5)
    exit(0)
}
dispatchMain()

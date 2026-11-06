import Foundation

/// Explicit cost/expiry bounds. Values never reach URLCache, disk or backups.
struct NativeMemoryCache<Value> {
    private struct Entry { let value: Value; let cost: Int; let expires: Date; var used: UInt64 }
    private var entries: [String: Entry] = [:]
    private var clock: UInt64 = 0
    private(set) var cost = 0
    let budget: Int
    let limit: Int
    init(budget: Int, limit: Int = 256) { self.budget = budget; self.limit = limit }
    mutating func value(for key: String, now: Date = Date()) -> Value? {
        guard var entry = entries[key] else { return nil }
        guard entry.expires > now else { remove(key); return nil }
        clock &+= 1; entry.used = clock; entries[key] = entry; return entry.value
    }
    mutating func insert(_ value: Value, for key: String, cost: Int, expires: Date, now: Date = Date()) {
        remove(key)
        guard cost >= 0, cost <= budget, expires > now, limit > 0 else { return }
        for key in entries.keys.filter({ entries[$0]!.expires <= now }) { remove(key) }
        while self.cost + cost > budget || entries.count >= limit {
            guard let oldest = entries.min(by: { $0.value.used < $1.value.used })?.key else { break }
            remove(oldest)
        }
        clock &+= 1; entries[key] = Entry(value: value, cost: cost, expires: expires, used: clock); self.cost += cost
    }
    private mutating func remove(_ key: String) { if let old = entries.removeValue(forKey: key) { cost -= old.cost } }
    mutating func clear() { entries.removeAll(); cost = 0 }
}

/// Short-lived presentation reads only. Permission snapshots and playback
/// authorization always use the network. Mutations invalidate before AND after.
actor NativeReadCache {
    private var values = NativeMemoryCache<Data>(budget: 32 * 1024 * 1024)
    private var pending: [String: (id: UUID, task: Task<Data, Error>)] = [:]
    private(set) var generation = 0
    static func permits(_ path: String) -> Bool {
        let parts = path.split(separator: "?", maxSplits: 1)[0].split(separator: "/").map(String.init)
        guard parts.count >= 3, parts[0] == "api", parts[1] == "v1" else { return false }
        let p = Array(parts.dropFirst(2))
        if p.count == 1 { return ["photo-feed", "feed", "photos", "albums", "connections", "groups"].contains(p[0]) }
        if p.count == 2 { return ["devices", "posts", "photos", "albums", "groups"].contains(p[0]) && UUID(uuidString: p[1]) != nil }
        if p.count == 3, UUID(uuidString: p[1]) != nil {
            return p[0] == "media" && p[2] == "bytes" || p[0] == "photos" && p[2] == "interactions"
        }
        return false
    }
    func invalidate() {
        generation += 1; values.clear()
        for work in pending.values { work.task.cancel() }; pending.removeAll()
    }
    func read(_ path: String, now: Date = Date(), load: @escaping @Sendable () async throws -> Data) async throws -> Data {
        try Task.checkCancellation()
        if let value = values.value(for: path, now: now) { return value }
        let epoch = generation
        let work: (id: UUID, task: Task<Data, Error>)
        if let existing = pending[path] { work = existing }
        else { work = (UUID(), Task { try await load() }); pending[path] = work }
        do {
            let value = try await work.task.value
            guard epoch == generation, !work.task.isCancelled else { throw CancellationError() }
            // Only the creator's first completion stores; a delayed waiter must
            // not renew the lifetime or remove a newer request for the same key.
            if pending[path]?.id == work.id {
                pending[path] = nil
                values.insert(value, for: path, cost: value.count, expires: now.addingTimeInterval(20))
            }
            try Task.checkCancellation(); return value
        } catch {
            if pending[path]?.id == work.id { pending[path] = nil }
            throw error
        }
    }
}

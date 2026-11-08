import Foundation
import UniformTypeIdentifiers

/// A local-only handoff. No account keys, network access or publishing in the extension.
enum SharedMediaInbox {
    struct Item: Codable, Sendable {
        let id: String
        let name: String
        let type: String
        let size: Int
    }
    struct Batch: Codable, Sendable {
        let id: String
        let created: Date
        let items: [Item]
    }
    static let maximumFileBytes = 1024 * 1024 * 1024
    static let maximumBatchBytes = 2 * 1024 * 1024 * 1024
    static func root() throws -> URL {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "PorchdayMediaGroup") as? String,
              !group.hasPrefix("."), !group.contains("$("),
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw CocoaError(.fileNoSuchFile)
        }
        let root = container.appendingPathComponent("SharedMedia", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return root
    }
    static func validID(_ id: String) -> Bool { UUID(uuidString: id) != nil && id == id.lowercased() }
    static func batches() throws -> [Batch] {
        let root = try root(), manager = FileManager.default
        var batches: [Batch] = []
        for directory in try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: [.creationDateKey]) {
            let age = (try? directory.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            if Date().timeIntervalSince(age) > 7 * 24 * 3600 { try? manager.removeItem(at: directory); continue }
            guard validID(directory.lastPathComponent),
                  let bytes = try? Data(contentsOf: directory.appendingPathComponent("manifest.json")), bytes.count < 32_768,
                  let batch = try? JSONDecoder().decode(Batch.self, from: bytes), batch.id == directory.lastPathComponent,
                  batch.items.count > 0, batch.items.count <= 10,
                  batch.items.allSatisfy({ validID($0.id) && $0.size > 0 && $0.size <= maximumFileBytes }) else { continue }
            batches.append(batch)
        }
        return batches.sorted { $0.created < $1.created }
    }
    static func file(batch: String, item: String) throws -> (URL, Item) {
        guard validID(batch), validID(item), let found = try batches().first(where: { $0.id == batch }),
              let record = found.items.first(where: { $0.id == item }) else { throw CocoaError(.fileNoSuchFile) }
        let url = try root().appendingPathComponent(batch).appendingPathComponent(item)
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, values.fileSize == record.size else { throw CocoaError(.fileReadCorruptFile) }
        return (url, record)
    }
    static func remove(_ id: String) throws {
        guard validID(id) else { throw CocoaError(.fileNoSuchFile) }
        try FileManager.default.removeItem(at: root().appendingPathComponent(id))
    }
    static func chunk(batch: String, item: String, offset: Int, count: Int) throws -> String {
        let (url, record) = try file(batch: batch, item: item)
        guard offset >= 0, offset <= record.size, count > 0, count <= 262_144 else { throw CocoaError(.fileReadCorruptFile) }
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        return try (handle.read(upToCount: min(count, record.size - offset)) ?? Data()).base64EncodedString()
    }
}

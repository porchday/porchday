import Foundation

/// Editors keep selection identity stable across separate upload attempts.
struct PreparedPhoto: Identifiable { let id = UUID().uuidString.lowercased(); let bytes: Data; let width: Int; let height: Int; var alt = "" }

@MainActor enum PhotoUpload {
    /// A manual retry can follow a committed reservation or a partly uploaded
    /// batch. Give every new sealed attempt a fresh identity; the pending old
    /// reservation is handled by server cleanup, never overwritten or reused.
    static func upload(_ photo: PreparedPhoto,
                       seal: @MainActor (JSON, String) async throws -> JSON,
                       reserve: @MainActor (JSON) async throws -> JSON,
                       put: @MainActor (String, Data) async throws -> Void) async throws -> JSON {
        let id = UUID().uuidString.lowercased()
        let metadata: JSON = .object(["id": .string(id), "mime": .string("image/jpeg"), "name": .string("photo.jpg"),
                                      "alt": .string(photo.alt), "width": .number(Double(photo.width)), "height": .number(Double(photo.height))])
        let envelope = try await seal(metadata.replacing("bytes", with: .string(photo.bytes.base64EncodedString())), id)
        let bytes = try JSONEncoder().encode(envelope)
        let upload = try await reserve(.object(["id": .string(id), "envelope": envelope, "byte_size": .number(Double(bytes.count))]))
        guard let path = upload["upload_url"].string else { throw PorchError.message("Photo upload was not authorized.") }
        try await put(path, bytes)
        return metadata
    }
}

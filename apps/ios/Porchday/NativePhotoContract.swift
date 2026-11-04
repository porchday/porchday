import Foundation
import CryptoKit

/// Shared wire rules for iOS and macOS. API authorization precedes these checks;
/// owner signatures bind media bytes and metadata independently of album grants.
enum NativePhotoContract {
    static func date(_ value: String) throws -> String {
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        guard value.count == 10, value >= "0001-01-01", let parsed = formatter.date(from: value), formatter.string(from: parsed) == value else { throw PorchError.message("Choose a valid photo date.") }
        return value
    }
    static func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    static func metadata(_ media: JSON) -> JSON { var fields = media.object; fields.removeValue(forKey: "id"); return .object(fields) }
    static func statement(id: String, owner: String, device: String, revision: Int, date: String, expiry: JSON, hash: String, media: JSON) throws -> JSON {
        guard revision > 0, hash.count == 64, hash.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { throw PorchError.message("Invalid photo proof.") }
        return .object(["v": .number(1), "purpose": .string("porchday-photo-source"), "photoId": .string(id), "ownerId": .string(owner), "deviceId": .string(device), "revision": .number(Double(revision)), "date": .string(try self.date(date)), "expiresAt": expiry, "sha256": .string(hash), "metadata": metadata(media)])
    }
    static func expiry(_ value: JSON) -> JSON { value.string.flatMap(PorchDate.parse).map { .string(PorchDate.string($0)) } ?? .null }
    static func context(kind: String, id: String, parent: String?, audience: String, album: String?, expiry: JSON, date: String? = nil, revision: Int = 1) -> JSON {
        var value: JSON = .object(["id": .string(id), "kind": .string(kind), "parentId": parent.map(JSON.string) ?? .null, "groupId": album.map(JSON.string) ?? .null, "audience": .string(audience), "createdAt": .string(PorchDate.string()), "expiresAt": expiry, "revision": .number(Double(revision))])
        if let date { value = value.replacing("photoDate", with: .string(date)) }; return value
    }
    static func matchesAuthor(_ row: JSON, selection: String, member: String) -> Bool {
        if row["author_id"].string == member { return true }
        if selection == "me" { return false }
        if selection == "community" { return true }
        if selection == "extended_family" { return row["author_in_extended_family"].boolean }
        let category = row["author_category"].string ?? ""
        return selection == "connections" ? ["friends", "family"].contains(category) : category == selection
    }
}

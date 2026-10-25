import Foundation

indirect enum JSON: Codable, Sendable, Equatable {
    case object([String: JSON]), array([JSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSON].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .object(let v): try c.encode(v); case .array(let v): try c.encode(v); case .string(let v): try c.encode(v); case .number(let v): try c.encode(v); case .bool(let v): try c.encode(v); case .null: try c.encodeNil() }
    }
    subscript(_ key: String) -> JSON { if case .object(let v) = self { return v[key] ?? .null }; return .null }
    var string: String? { if case .string(let v) = self { return v }; return nil }
    var array: [JSON] { if case .array(let v) = self { return v }; return [] }
    var object: [String: JSON] { if case .object(let v) = self { return v }; return [:] }
    var integer: Int? { if case .number(let v) = self, v.isFinite, v >= Double(Int.min), v < Double(Int.max) { return Int(v) }; return nil }
    var boolean: Bool { if case .bool(let v) = self { return v }; return false }
    func replacing(_ key: String, with value: JSON) -> JSON { var copy = object; copy[key] = value; return .object(copy) }
    func serialized() throws -> String { let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]; return String(decoding: try encoder.encode(self), as: UTF8.self) }
    static func parse(_ text: String) throws -> JSON { try JSONDecoder().decode(JSON.self, from: Data(text.utf8)) }
    static func id() -> JSON { .string(UUID().uuidString.lowercased()) }
}

struct Member: Identifiable, Sendable { let id: String; let handle: String; let raw: JSON
    init(_ json: JSON) throws { guard let id = json["id"].string, let handle = json["handle"].string else { throw PorchError.message("Your account details are unavailable.") }; self.id = id; self.handle = handle; raw = json }
}
struct Device: Identifiable, Sendable { let id: String; let memberID: String; let publicKey: String; let fingerprint: String; let revoked: Bool
    init(_ j: JSON) throws { guard let id = j["id"].string, let member = j["member_id"].string, let key = j["public_key"].string, let fp = j["fingerprint"].string else { throw PorchError.message("A device identity is incomplete.") }; self.id = id; memberID = member; publicKey = key; fingerprint = fp; revoked = j["revoked_at"] != .null }
    var recipient: JSON { .object(["memberId": .string(memberID), "deviceId": .string(id), "publicKey": .string(publicKey)]) }
}
struct SocialItem: Identifiable, Sendable { let id: String; let raw: JSON; let envelope: JSON; let payload: JSON?; let error: String?
    var context: JSON { envelope["context"] }
    var authorID: String { raw["author_id"].string ?? context["authorId"].string ?? "" }
    var authorHandle: String { raw["author_handle"].string.map { "@" + $0 } ?? "A person in your circle" }
    var expiry: Date? { let values = [raw["effective_expires_at"].string, raw["expires_at"].string, context["expiresAt"].string].compactMap { $0 }.compactMap(PorchDate.parse); return values.min() }
    var active: Bool { expiry.map { $0 > Date() } ?? true }
    var text: String { payload?["text"].string ?? "" }
    var created: Date? { PorchDate.parse(raw["created_at"].string ?? context["createdAt"].string ?? "") }
    var isComment: Bool { context["kind"].string == "comment" }
}

enum PorchDate {
    static func minimum(_ values:[JSON]) -> Date? { values.compactMap { $0.string.flatMap(parse) }.min() }
    static func string(_ date: Date = Date()) -> String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: date) }
    static func parse(_ value: String) -> Date? { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; if let date = f.date(from: value) { return date }; f.formatOptions = [.withInternetDateTime]; return f.date(from: value) }
    static func deadline(seconds: Int, parent: Date?) -> Date? { let own = seconds > 0 ? Date().addingTimeInterval(TimeInterval(seconds)) : nil; if let parent { return own.map { min($0, parent) } ?? parent }; return own }
}
enum PorchError: LocalizedError { case message(String); case api(code:String,message:String,details:JSON)
    var errorDescription: String? { switch self { case .message(let value): value;case .api(_,let message,_):message } }
}
let reactionCatalog: [(id: String, emoji: String, label: String)] = [("like","👍","Like"),("love","❤️","Love"),("laugh","😄","Laugh"),("celebrate","🎉","Celebrate"),("care","🤗","Care"),("sunshine","☀️","Sunshine")]

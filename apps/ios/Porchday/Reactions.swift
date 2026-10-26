import Foundation
import CryptoKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct UnicodeReactionEntry: Codable, Identifiable, Sendable {
    let unicode: String
    let name: String
    let group: String
    let subgroup: String
    let version: String
    let aliases: [String]
    var id: String { unicode }
}
enum UnicodeReactions {
    private struct Catalog: Decodable { let version: String; let emojis: [UnicodeReactionEntry] }
    static let entries: [UnicodeReactionEntry] = {
        guard let url = Bundle.main.url(forResource: "emoji-17.0", withExtension: "json"),
              let data = try? Data(contentsOf: url), let catalog = try? JSONDecoder().decode(Catalog.self, from: data), catalog.version == "17.0" else { return [] }
        return catalog.emojis
    }()
    static let aliases: [String: UnicodeReactionEntry] = {
        var result: [String: UnicodeReactionEntry] = [:]
        for entry in entries { for alias in entry.aliases { result[alias] = entry }; result[entry.unicode] = entry }
        return result
    }()
}

struct ReactionValue: Identifiable, Equatable, Sendable {
    let id: String
    let payload: JSON
    let label: String
    let unicode: String?
    let png: Data?
    var isCustom: Bool { png != nil }
    static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    static func legacy(_ id: String) throws -> ReactionValue {
        guard let entry = reactionCatalog.first(where: { $0.id == id }) else { throw PorchError.message("Unsupported reaction.") }
        return ReactionValue(id: id, payload: .object(["emoji": .string(id)]), label: entry.label, unicode: entry.emoji, png: nil)
    }
    static func emoji(_ input: String) throws -> ReactionValue {
        guard input.utf8.count <= 256 else { throw PorchError.message("Choose one emoji.") }
        let normalized = input.precomposedStringWithCanonicalMapping
        if let legacy = reactionCatalog.first(where: { $0.emoji == normalized }) { return try self.legacy(legacy.id) }
        guard let entry = UnicodeReactions.aliases[normalized] else { throw PorchError.message("Choose one supported emoji, including any skin tone or variation.") }
        if let legacy = reactionCatalog.first(where: { $0.emoji == entry.unicode }) { return try self.legacy(legacy.id) }
        let id = "u1_" + digest(Data(entry.unicode.utf8))
        return ReactionValue(id: id, payload: .object(["emoji": .string(id), "unicode": .string(entry.unicode)]), label: entry.name, unicode: entry.unicode, png: nil)
    }
    static func custom(name: String, png: Data) throws -> ReactionValue {
        guard name.range(of: #"^[a-z0-9_]{1,32}\z"#, options: .regularExpression) != nil else { throw PorchError.message("Use 1–32 lowercase letters, numbers or underscores for the emoji name.") }
        _ = try ReactionPNG.decode(png)
        let id = "c1_" + digest(png)
        return ReactionValue(id: id, payload: .object(["emoji": .string(id), "custom": .object(["name": .string(name), "png": .string(png.base64EncodedString())])]), label: name, unicode: nil, png: png)
    }
    static func parse(_ payload: JSON) throws -> ReactionValue {
        let keys = Set(payload.object.keys)
        guard let id = payload["emoji"].string else { throw PorchError.message("Invalid reaction.") }
        if keys == ["emoji"] { return try legacy(id) }
        if keys == ["emoji", "unicode"], let value = payload["unicode"].string {
            let reaction = try emoji(value)
            guard reaction.id == id, reaction.payload == payload else { throw PorchError.message("Emoji identity mismatch.") }
            return reaction
        }
        if keys == ["emoji", "custom"], Set(payload["custom"].object.keys) == ["name", "png"],
           let name = payload["custom"]["name"].string, let encoded = payload["custom"]["png"].string,
           encoded.utf8.count <= 43692, let bytes = Data(base64Encoded: encoded), bytes.base64EncodedString() == encoded {
            let reaction = try custom(name: name, png: bytes)
            guard reaction.id == id else { throw PorchError.message("Custom emoji identity mismatch.") }
            return reaction
        }
        throw PorchError.message("Unsupported reaction format.")
    }
}

/// Structural checks precede ImageIO decoding. Received bytes are never
/// reencoded: their exact SHA-256 identity is shared by every client.
enum ReactionPNG {
    static let maximumBytes = 32768
    static let signature: [UInt8] = [137,80,78,71,13,10,26,10]
    static func crc(_ bytes: ArraySlice<UInt8>) -> UInt32 {
        var value: UInt32 = 0xffffffff
        for byte in bytes { value ^= UInt32(byte); for _ in 0..<8 { value = (value >> 1) ^ (value & 1 == 0 ? 0 : 0xedb88320) } }
        return value ^ 0xffffffff
    }
    static func dimensions(_ data: Data) throws -> (Int, Int) {
        let failure = PorchError.message("Choose a static PNG no larger than 128 × 128 pixels and 32 KB.")
        guard data.count <= maximumBytes, data.count >= 57 else { throw failure }
        let bytes = [UInt8](data)
        guard Array(bytes.prefix(8)) == signature else { throw failure }
        func word(_ offset: Int) -> UInt32 { bytes[offset..<offset+4].reduce(0) { ($0 << 8) | UInt32($1) } }
        var offset = 8, width = 0, height = 0, color: UInt8 = 0, depth: UInt8 = 0
        var seen = Set<String>(), paletteCount = 0, idat = false, endedIDAT = false, idatBytes = 0
        let allowed: Set<String> = ["IHDR","PLTE","tRNS","IDAT","IEND","sRGB","gAMA","cHRM","pHYs"]
        while offset < bytes.count {
            guard bytes.count - offset >= 12 else { throw failure }
            let size = Int(word(offset)), end = offset + 12 + size
            guard end <= bytes.count, let kind = String(bytes: bytes[offset+4..<offset+8], encoding: .ascii), allowed.contains(kind),
                  crc(bytes[offset+4..<offset+8+size]) == word(offset+8+size) else { throw failure }
            if kind != "IDAT", !seen.insert(kind).inserted { throw failure }
            if offset == 8 && kind != "IHDR" { throw failure }
            if idat && kind != "IDAT" { endedIDAT = true }
            switch kind {
            case "IHDR":
                guard offset == 8, size == 13 else { throw failure }
                width = Int(word(offset+8)); height = Int(word(offset+12)); depth = bytes[offset+16]; color = bytes[offset+17]
                let validDepths: [UInt8: Set<UInt8>] = [0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]]
                guard (1...128).contains(width), (1...128).contains(height), validDepths[color]?.contains(depth) == true,
                      bytes[offset+18] == 0, bytes[offset+19] == 0, bytes[offset+20] <= 1 else { throw failure }
            case "PLTE":
                guard !idat, !seen.contains("tRNS"), color != 0, color != 4, size > 0, size % 3 == 0, size <= 768 else { throw failure }
                paletteCount = size / 3
                if color == 3 && paletteCount > (1 << Int(depth)) { throw failure }
            case "tRNS":
                guard !idat, (color == 0 && size == 2) || (color == 2 && size == 6) || (color == 3 && paletteCount > 0 && size > 0 && size <= paletteCount) else { throw failure }
            case "IDAT":
                guard !endedIDAT, color != 3 || paletteCount > 0 else { throw failure }; idat = true; idatBytes += size
            case "IEND":
                guard size == 0, idat, idatBytes > 0, end == bytes.count else { throw failure }; return (width,height)
            case "sRGB": guard !idat, !seen.contains("PLTE"), size == 1, bytes[offset+8] <= 3 else { throw failure }
            case "gAMA": guard !idat, !seen.contains("PLTE"), size == 4, word(offset+8) > 0 else { throw failure }
            case "cHRM": guard !idat, !seen.contains("PLTE"), size == 32 else { throw failure }
            case "pHYs": guard !idat, size == 9, bytes[offset+16] <= 1 else { throw failure }
            default: throw failure
            }
            offset = end
        }
        throw failure
    }
    static func decode(_ data: Data) throws -> CGImage {
        let (width,height) = try dimensions(data)
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache:false] as CFDictionary),
              CGImageSourceGetType(source) as String? == UTType.png.identifier, CGImageSourceGetCount(source) == 1,
              CGImageSourceGetStatus(source) == .statusComplete, CGImageSourceGetStatusAtIndex(source,0) == .statusComplete,
              let image = CGImageSourceCreateImageAtIndex(source,0,[kCGImageSourceShouldCacheImmediately:true] as CFDictionary), image.width == width, image.height == height else { throw PorchError.message("This custom emoji could not be decoded safely.") }
        return image
    }
}

enum EmojiLibraryPayload {
    static let maximumCount = 48
    static let maximumBytes = 2_150_000
    static func parse(_ payload: JSON) throws -> [ReactionValue] {
        guard Set(payload.object.keys) == ["customEmojis"], case .array(let entries) = payload["customEmojis"], entries.count <= maximumCount,
              try payload.serialized().utf8.count <= maximumBytes else { throw PorchError.message("The custom emoji collection exceeds its limits.") }
        var ids = Set<String>()
        return try entries.map { raw in let item = try ReactionValue.parse(raw); guard item.isCustom, ids.insert(item.id).inserted else { throw PorchError.message("Invalid or duplicate custom emoji.") }; return item }
    }
    static func encode(_ entries: [ReactionValue]) throws -> JSON {
        let result: JSON = .object(["customEmojis": .array(entries.map(\.payload))]); _ = try parse(result); return result
    }
    static func merge(_ existing: [ReactionValue], _ incoming: [ReactionValue]) throws -> [ReactionValue] {
        var ids = Set(existing.map(\.id)), result = existing
        for item in incoming where ids.insert(item.id).inserted { result.append(item) }
        _ = try encode(result); return result
    }
}

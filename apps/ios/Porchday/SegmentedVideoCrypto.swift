import Foundation
import CryptoKit

struct VideoV2Segment: Codable, Sendable {
    let index: Int
    let size: Int
    let sha256: String
    let nonce: String
}
struct VideoV2Manifest: Codable, Sendable {
    let v: Int
    let `protocol`: String
    let streamId: String
    let key: String
    let mime: String
    let size: Int
    let duration: Double
    let width: Int
    let height: Int
    let chunkSize: Int
    var segments: [VideoV2Segment]
}
enum VideoV2Error: Error, LocalizedError {
    case invalidManifest, integrity
    var errorDescription: String? { self == .invalidManifest ? "This video has invalid encrypted metadata." : "This video failed its integrity check." }
}
/// WebCrypto AES-GCM wire format: ciphertext followed by its 16-byte tag;
/// nonce and key remain inside the authenticated OpenPGP manifest.
enum SegmentedVideoCrypto {
    static let chunkBytes = 4 * 1024 * 1024
    static let maximumBytes = 250 * 1024 * 1024
    static let maximumChunks = 63
    static func fixedBase64(_ text: String, count: Int) throws -> Data {
        guard let bytes = Data(base64Encoded: text), bytes.count == count, bytes.base64EncodedString() == text else { throw VideoV2Error.invalidManifest };return bytes
    }
    static func validID(_ id: String) -> Bool { UUID(uuidString: id)?.uuidString.lowercased() == id }
    static func validate(_ m: VideoV2Manifest) throws {
        guard m.v == 2, m.protocol == "porchday-video-aes256gcm-v2", validID(m.streamId), m.mime == "video/mp4", m.chunkSize == chunkBytes,
              m.size > 0, m.size <= maximumBytes, m.duration.isFinite, m.duration > 0, m.duration <= 600,
              m.width > 0, m.height > 0, max(m.width,m.height) <= 1920, min(m.width,m.height) <= 1080,
              m.segments.count == (m.size + chunkBytes - 1) / chunkBytes, m.segments.count <= maximumChunks else { throw VideoV2Error.invalidManifest }
        _ = try fixedBase64(m.key, count: 32)
        var nonces = Set<String>()
        for (index, segment) in m.segments.enumerated() {
            guard segment.index == index, segment.size == min(chunkBytes,m.size-index*chunkBytes)+16,
                  segment.sha256.count == 64, segment.sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
                  nonces.insert(segment.nonce).inserted else { throw VideoV2Error.invalidManifest }
            _ = try fixedBase64(segment.nonce, count: 12)
        }
    }
    static func decode(_ data: Data) throws -> VideoV2Manifest {
        guard data.count <= 100_000, let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["v","protocol","streamId","key","mime","size","duration","width","height","chunkSize","segments"]),
              let segments = object["segments"] as? [[String:Any]], segments.allSatisfy({ Set($0.keys) == Set(["index","size","sha256","nonce"]) }) else { throw VideoV2Error.invalidManifest }
        let manifest = try JSONDecoder().decode(VideoV2Manifest.self, from: data);try validate(manifest);return manifest
    }
    static func additionalData(stream: String, index: Int, size: Int) throws -> Data {
        guard validID(stream), (0..<maximumChunks).contains(index), (1...chunkBytes).contains(size) else { throw VideoV2Error.invalidManifest }
        return Data("porchday-video-v2\n\(stream)\n\(index)\n\(size)".utf8)
    }
    static func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    static func newKey() -> String { SymmetricKey(size: .bits256).withUnsafeBytes { Data($0).base64EncodedString() } }
    static func encrypt(_ data: Data, key: String, stream: String, index: Int) throws -> (Data,VideoV2Segment) {
        let aad = try additionalData(stream: stream,index: index,size: data.count), key = SymmetricKey(data: try fixedBase64(key,count: 32))
        let nonce = AES.GCM.Nonce(), box = try AES.GCM.seal(data, using: key, nonce: nonce, authenticating: aad)
        let bytes = box.ciphertext + box.tag
        return (bytes,VideoV2Segment(index: index,size: bytes.count,sha256: hash(bytes),nonce: nonce.withUnsafeBytes { Data($0).base64EncodedString() }))
    }
    static func decrypt(_ data: Data, manifest: VideoV2Manifest, index: Int) throws -> Data {
        try validate(manifest)
        guard manifest.segments.indices.contains(index) else { throw VideoV2Error.integrity }
        let s = manifest.segments[index]
        guard data.count == s.size, hash(data) == s.sha256 else { throw VideoV2Error.integrity }
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: fixedBase64(s.nonce,count: 12)),ciphertext: data.dropLast(16),tag: data.suffix(16))
        return try AES.GCM.open(box,using: SymmetricKey(data: fixedBase64(manifest.key,count: 32)),authenticating: additionalData(stream: manifest.streamId,index: index,size: s.size-16))
    }
}

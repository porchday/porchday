import SwiftUI
import AVKit
import ImageIO

/// Matches the web media container contract. The decoder also validates playability
/// and dimensions before upload/playback; filenames and caller MIME are not trusted.
enum VideoContainer {
    static let maximumBytes = 10 * 1024 * 1024
    static func mime(_ data: Data) throws -> String {
        let bytes = [UInt8](data)
        guard !bytes.isEmpty, bytes.count <= maximumBytes else { throw PorchError.message("Choose a video up to 10 MiB.") }
        func ascii(_ a: Int, _ b: Int) -> String { String(bytes: bytes[a..<b], encoding: .ascii) ?? "" }
        if bytes.count >= 16, ascii(4, 8) == "ftyp" {
            let size = bytes.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
            if size >= 16, size <= bytes.count, size <= 4096 {
                var brands = [ascii(8, 12)]
                for i in stride(from: 16, through: size - 4, by: 4) { brands.append(ascii(i, i + 4)) }
                if brands.contains("qt  ") { return "video/quicktime" }
                if brands.contains(where: { ["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9", "mp41", "mp42", "avc1", "M4V "].contains($0) }) { return "video/mp4" }
            }
        }
        if bytes.count >= 11, Array(bytes.prefix(4)) == [0x1a, 0x45, 0xdf, 0xa3] {
            for i in 4..<min(bytes.count - 6, 4096) {
                if bytes[i] == 0x42, bytes[i + 1] == 0x82, bytes[i + 2] == 0x84, ascii(i + 3, i + 7) == "webm" { return "video/webm" }
            }
        }
        throw PorchError.message("Choose an MP4, MOV or WebM video.")
    }
    static func fileExtension(_ mime: String) -> String { mime == "video/quicktime" ? "mov" : mime == "video/webm" ? "webm" : "mp4" }
}
/// Only a selected clip is written here, with private permissions and deterministic
/// cleanup. These files are excluded from backups and never shared as export URLs.
final class PrivateMediaFile {
    static func cleanAbandonedFiles() {
        let temporary = FileManager.default.temporaryDirectory
        for url in (try? FileManager.default.contentsOfDirectory(at: temporary, includingPropertiesForKeys: nil)) ?? [] where url.lastPathComponent.hasPrefix("porchday-video-") { try? FileManager.default.removeItem(at: url) }
    }
    let url: URL
    private let directory: URL
    init(_ data: Data, ext: String) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("porchday-video-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        url = directory.appendingPathComponent("clip." + ext)
        do {
            try data.write(to: url, options: SecureTemporaryFiles.writeOptions)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            var mutable = url; var values = URLResourceValues(); values.isExcludedFromBackup = true; try mutable.setResourceValues(values)
        } catch { try? FileManager.default.removeItem(at: directory); throw error }
    }
    deinit { try? FileManager.default.removeItem(at: directory) }
}
@MainActor enum VideoPipeline {
    static func prepare(_ bytes: Data) async throws -> PreparedPhoto {
        let mime = try VideoContainer.mime(bytes), file = try PrivateMediaFile(bytes, ext: VideoContainer.fileExtension(mime))
        let asset = AVURLAsset(url: file.url)
        guard try await asset.load(.isPlayable), let track = try await asset.loadTracks(withMediaType: .video).first else { throw PorchError.message("This Apple device cannot play this codec. Choose an H.264 MP4 video.") }
        let size = try await track.load(.naturalSize), duration = try await asset.load(.duration).seconds
        guard size.width > 0, size.height > 0, size.width <= 3840, size.height <= 3840, size.width * size.height <= 3840 * 2160, duration.isFinite, duration > 0 else { throw PorchError.message("Choose a playable video up to 4K resolution.") }
        let generator = AVAssetImageGenerator(asset: asset); generator.appliesPreferredTrackTransform = true; generator.maximumSize = CGSize(width: 320, height: 320)
        let (frame, _) = try await generator.image(at: .zero)
        let poster = try AppleImageEncoder.encode(AppleImageEncoder.opaque(frame), jpeg: true)
        return PreparedPhoto(bytes: bytes, width: Int(size.width), height: Int(size.height), mime: mime, poster: poster.base64EncodedString())
    }
}
struct EncryptedMediaView: View {
    let media: JSON
    var thumbnail = false
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @Environment(\.scenePhase) private var phase
    @State private var player: AVPlayer?
    @State private var file: PrivateMediaFile?
    @State private var expiry: Date?
    @State private var error = ""
    @State private var busy = false
    var body: some View {
        if media["mime"].string == nil || media["mime"].string == "image/jpeg" {
            EncryptedPhotoView(photo: media)
        } else {
            TimelineView(.periodic(from: .now, by: 1)) { clock in
                let expired = expiry.map { $0 <= clock.date } ?? false
                VStack {
                    if expired { Text("This video has expired.") }
                    else if let player { VideoPlayer(player: player).frame(minHeight: 200) }
                    else {
                        if let data = media["poster"].string.flatMap({ Data(base64Encoded: $0) }), data.count <= 200_000,
                           let image = try? PhotoPipeline.safelyDecode(data) { Image(platformImage: image).resizable().scaledToFit() }
                        if thumbnail { Image(systemName: "play.circle.fill").accessibilityLabel("Video") }
                        else { Button(busy ? "Opening video…" : "Play video") { Task { await open() } }.disabled(busy) }
                    }
                    if !error.isEmpty { Text(error).foregroundStyle(.red) }
                    if !thumbnail, let caption = media["caption"].string, !caption.isEmpty { Text(caption) }
                    if !thumbnail { PeopleTagsView(tags: PersonTag.parse(media["tags"])) }
                }.onChange(of: expired) { _, expired in if expired { clear() } }
            }.onDisappear { clear() }
            .onChange(of: model.authenticationGeneration) { _, _ in clear() }
            .onChange(of: phase) { _, value in if value != .active { clear() } }
        }
    }
    private func clear() { player?.pause(); player?.replaceCurrentItem(with: nil); player = nil; file = nil }
    private func open() async {
        busy = true; error = ""; defer { busy = false }
        let generation = model.authenticationGeneration
        do {
            guard let id = media["id"].string, UUID(uuidString: id) != nil else { throw PorchError.message("Invalid media identity.") }
            let bytes = try await model.api.bytes("/api/v1/media/" + id + "/bytes")
            let envelope = try JSONDecoder().decode(JSON.self, from: bytes)
            let content = try await vault.open(.object(["id": .string(id), "envelope": envelope]))
            guard envelope["context"]["kind"].string == "media", let data = content["bytes"].string.flatMap({ Data(base64Encoded: $0) }),
                  try VideoContainer.mime(data) == content["mime"].string, content["mime"] == media["mime"] else { throw PorchError.message("Video metadata does not match its encrypted content.") }
            expiry = envelope["context"]["expiresAt"].string.flatMap(PorchDate.parse)
            guard expiry.map({ $0 > Date() }) ?? true else { throw PorchError.message("This video has expired.") }
            _ = try await VideoPipeline.prepare(data)
            guard generation == model.authenticationGeneration, vault.unlocked, !Task.isCancelled, phase == .active else { return }
            let owned = try PrivateMediaFile(data, ext: VideoContainer.fileExtension(content["mime"].string!))
            file = owned; player = AVPlayer(url: owned.url)
        } catch { self.error = error.localizedDescription; clear() }
    }
}

import SwiftUI
import UIKit

struct ProfileAvatarImage { let image: UIImage; let expires: Date }

/// A small, memory-only cache shared by repeated appearances of the same person.
@MainActor final class ProfileAvatarCache {
    private struct Entry { let image: UIImage?; let expires: Date; let checked: Date }
    private var entries: [String: Entry] = [:]
    private var tasks: [String: Task<(UIImage?, Date), Error>] = [:]
    private var generation = 0
    private func trim() {
        if entries.count >= 100, let oldest = entries.min(by: { $0.value.checked < $1.value.checked })?.key { entries[oldest] = nil }
    }
    func clear() {
        generation += 1
        for task in tasks.values { task.cancel() }
        tasks.removeAll(); entries.removeAll()
    }
    func image(for key: String, load: @escaping @MainActor () async throws -> (UIImage?, Date)) async throws -> ProfileAvatarImage? {
        if let entry = entries[key], entry.expires > Date(), Date().timeIntervalSince(entry.checked) < 60 { return entry.image.map { ProfileAvatarImage(image: $0, expires: entry.expires) } }
        let current = generation
        let task = tasks[key] ?? Task { try await load() }
        tasks[key] = task
        do {
            let (image, expires) = try await task.value
            guard generation == current, !task.isCancelled else { throw CancellationError() }
            tasks[key] = nil
            trim()
            entries[key] = Entry(image: image, expires: expires, checked: Date())
            return expires > Date() ? image.map { ProfileAvatarImage(image: $0, expires: expires) } : nil
        } catch {
            if generation == current {
                tasks[key] = nil
                // Failed/private profiles use initials, with a bounded retry rate.
                trim()
                entries[key] = Entry(image: nil, expires: Date().addingTimeInterval(60), checked: Date())
            }
            throw error
        }
    }
}

extension CryptoVault {
    func profileAvatar(memberID: String, viewerID: String) async throws -> ProfileAvatarImage? {
        guard let device, !device.revoked else { return nil }
        let identity = viewerID + ":" + device.id + ":" + memberID
        return try await avatars.image(for: identity) {
            let profile = try await API.shared.social(memberID == viewerID ? "/me" : "/profiles/member/" + memberID)
            let context = profile["envelope"]["context"]
            if profile["envelope"] == .null { return (nil, .distantFuture) }
            guard context["kind"].string == "profile", context["id"].string == memberID, context["authorId"].string == memberID else { throw PorchError.message("Profile identity mismatch.") }
            let payload = try await self.open(.object(["id": .string(memberID), "author_id": .string(memberID), "envelope": profile["envelope"]]))
            try Task.checkCancellation()
            guard let photoID = payload["avatar"]["id"].string else { return (nil, .distantFuture) }
            guard UUID(uuidString: photoID) != nil else { throw PorchError.message("Invalid profile photo.") }
            let bytes = try await API.shared.bytes("/api/v1/media/" + photoID + "/bytes")
            let envelope = try JSONDecoder().decode(JSON.self, from: bytes), photoContext = envelope["context"]
            guard photoContext["kind"].string == "media", photoContext["id"].string == photoID,
                  photoContext["authorId"].string == memberID, photoContext["parentId"].string == memberID,
                  photoContext["groupId"] == .null else { throw PorchError.message("Profile photo identity mismatch.") }
            let content = try await self.open(.object(["id": .string(photoID), "author_id": .string(memberID), "envelope": envelope]))
            guard content["mime"].string == "image/jpeg", let encoded = content["bytes"].string,
                  let data = Data(base64Encoded: encoded) else { throw PorchError.message("Unsupported photo format.") }
            let expires: Date
            if photoContext["expiresAt"] == .null { expires = .distantFuture }
            else if let date = photoContext["expiresAt"].string.flatMap(PorchDate.parse) { expires = date }
            else { throw PorchError.message("Invalid photo expiration.") }
            guard expires > Date() else { return (nil, expires) }
            let decoded = try PhotoPipeline.safelyDecode(data)
            // Retain a thumbnail, not a full-sized photo for every author.
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let scale = 144 / max(decoded.size.width, decoded.size.height)
            let size = CGSize(width: decoded.size.width * scale, height: decoded.size.height * scale)
            let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in decoded.draw(in: CGRect(origin: .zero, size: size)) }
            try Task.checkCancellation()
            return (image, expires)
        }
    }
}

struct MemberAvatarView: View {
    let memberID: String
    var name: String = "?"
    var size: CGFloat = 36
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @Environment(\.scenePhase) private var scenePhase
    @State private var loaded: (identity: String, photo: ProfileAvatarImage)?
    private var identity: String { "\(model.member?.id ?? ""):\(vault.device?.id ?? ""):\(vault.avatarVersion):\(memberID):\(scenePhase)" }
    private var initial: String { String((memberID == model.member?.id ? model.member?.handle ?? name : name).replacingOccurrences(of: "@", with: "").prefix(1)).uppercased() }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { clock in
            ZStack {
                Color.secondary.opacity(0.15)
                if let loaded, loaded.identity == identity, loaded.photo.expires > clock.date, vault.unlocked {
                    Image(uiImage: loaded.photo.image).resizable().scaledToFill()
                } else { Text(initial.isEmpty ? "?" : initial).font(.system(size: size * 0.5, design: .serif)).foregroundStyle(.secondary) }
            }.frame(width: size, height: size).clipShape(Circle())
                .onChange(of: loaded.map { $0.photo.expires <= clock.date } ?? false) { _, expired in if expired { loaded = nil } }
        }.accessibilityHidden(true)
        .task(id: identity) {
            loaded = nil
            let expected = identity
            guard scenePhase == .active, let viewerID = model.member?.id, vault.unlocked else { return }
            while !Task.isCancelled {
                let image = try? await vault.profileAvatar(memberID: memberID, viewerID: viewerID)
                guard !Task.isCancelled, identity == expected else { return }
                loaded = image.map { (expected, $0) }
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }.onDisappear { loaded = nil }
    }
}

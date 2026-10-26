import SwiftUI

struct ResharePostView: View {
    let item: SocialItem
    let submitted: () -> Void
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @Environment(\.dismiss) private var dismiss
    @State private var audience = "connections"
    @State private var busy = false
    var body: some View {
        Form {
            Section {
                Text("Share a fresh copy of your post with the selected current audience. Comments and reactions remain on the original post.")
                Text(item.text)
                if let expiry = item.expiry { Label("The original deadline remains: \(expiry.formatted()).", systemImage: "timer") }
            }
            if item.context["groupId"] == .null {
                Picker("Share with", selection: $audience) {
                    ForEach(SharingAudience.allCases) { Text($0.label).tag($0.rawValue) }
                }
                if audience == SharingAudience.friends.rawValue { Text("Excludes connections labeled family.").font(.footnote).foregroundStyle(.secondary) }
            } else { Text("The copy will be shared with current group members.") }
            Button(busy ? "Encrypting…" : "Share this post again") { Task { await share() } }.disabled(!model.canWriteSocial || busy || item.payload == nil || !item.active)
        }
        .navigationTitle("Reshare post")
        .toolbar { Button("Cancel") { dismiss() } }
        .task { audience = item.context["audience"].string ?? "connections" }
    }
    private func share() async {
        busy = true; defer { busy = false }
        await model.perform {
            guard let member = model.member, var payload = item.payload, item.authorID == member.id else { throw PorchError.message("Only the author can share this post again.") }
            try member.access.requireSocialWrite()
            let newID = UUID().uuidString.lowercased(), group = item.context["groupId"].string, share = group == nil ? audience : "group"
            var media: [JSON] = []
            for photo in payload["media"].array { media.append(try await model.reshareSurfacePhoto(photo, audience: share, parent: newID, group: group, parentExpiry: item.expiry)) }
            payload = payload.replacing("media", with: .array(media)).replacing("reactionSecret", with: .string(try CryptoVault.randomSecret()))
            let envelope = try await vault.seal(payload, member: member, kind: "post", audience: share, id: newID, group: group, expiry: item.expiry)
            _ = try await model.api.social("/posts/" + item.id + "/reshare", method: "POST", body: .object([
                "envelope": envelope, "media_ids": .array(media.map { $0["id"] }),
                "source_expires_at": item.expiry.map { .string(PorchDate.string($0)) } ?? .null
            ]))
            submitted(); dismiss()
        }
    }
}

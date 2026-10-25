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
                    Text("Friends & family").tag("connections")
                    Text("Family only").tag("family")
                    Text("Only me").tag("only_me")
                }
            } else { Text("The fresh copy will be shared with current members of this group.") }
            Button(busy ? "Encrypting a fresh copy…" : "Share this post again") { Task { await share() } }.disabled(!model.canWriteSocial || busy || item.payload == nil || !item.active)
        }
        .navigationTitle("Share with your people")
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

import SwiftUI

enum PhotoInteractionContract {
    static let emoji = ["like", "love", "laugh", "celebrate", "care", "sunshine"]
    static func validate(_ row: JSON, photo: JSON) throws {
        let c = row["envelope"]["context"]
        guard c["id"] == row["id"], c["authorId"] == row["author_id"], row["photo_id"] == photo["id"], c["parentId"] == photo["id"], c["audience"].string == "photo", c["groupId"] == .null, c["kind"] == row["kind"], ["comment", "reaction"].contains(c["kind"].string ?? ""), c["revision"].integer == 1, NativePhotoContract.expiry(c["expiresAt"]) == NativePhotoContract.expiry(photo["expires_at"]) else { throw PorchError.message("Photo conversation identity did not match its signed content.") }
    }
}

struct NativePhotoInteractions: View {
    let photo: JSON
    @EnvironmentObject var model: AppModel
    @State private var expanded = false
    @State private var rows: [SocialItem] = []
    @State private var next: String?
    @State private var ownReaction: SocialItem?
    @State private var text = ""
    @State private var error = ""
    @State private var busy = false
    @State private var pending: JSON?
    @State private var pendingValue = ""
    private var path: String { "/photos/" + (photo["id"].string ?? "") + "/interactions" }
    private var own: SocialItem? { ownReaction ?? rows.first { $0.raw["kind"].string == "reaction" && $0.raw["author_id"].string == model.member?.id } }
    private var reactions: [SocialItem] {
        let listed = rows.filter { $0.raw["kind"].string == "reaction" }
        if let ownReaction, !listed.contains(where: { $0.id == ownReaction.id }) { return listed + [ownReaction] }; return listed
    }
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Shared with people who can see this photo, including through its albums. New viewers may not see earlier comments.").font(.caption).foregroundStyle(.secondary)
                if !error.isEmpty { Text(error).foregroundStyle(.red); Button("Retry loading") { Task { await load() } }.disabled(busy) }
                HStack {
                    ForEach(PhotoInteractionContract.emoji, id: \.self) { emoji in
                        Button(reactionCatalog.first { $0.id == emoji }?.emoji ?? emoji) { Task { await send(kind: "reaction", value: emoji) } }
                            .accessibilityLabel("React " + (reactionCatalog.first { $0.id == emoji }?.label ?? emoji))
                            .accessibilityValue(own?.payload?["emoji"].string == emoji ? "Selected" : "")
                            .disabled(busy || !model.canWriteSocial)
                    }
                }
                ForEach(reactions) { row in
                    Text(row.error ?? ((reactionCatalog.first { $0.id == row.payload?["emoji"].string }?.emoji ?? "Reaction") + " @" + (row.raw["author_handle"].string ?? "member"))).font(.caption)
                }
                ForEach(rows.filter { $0.raw["kind"].string == "comment" }) { row in
                    VStack(alignment: .leading) {
                        Text("@" + (row.raw["author_handle"].string ?? "member")).font(.headline)
                        Text(row.error ?? row.payload?["text"].string ?? "")
                        if model.canWriteSocial && (row.raw["author_id"].string == model.member?.id || photo["owner_id"].string == model.member?.id) {
                            Button("Delete comment", role: .destructive) { Task { await remove(row.id) } }.disabled(busy)
                        }
                    }
                }
                if let next { Button("Load more comments and reactions") { Task { await load(after: next) } }.disabled(busy) }
                if model.canWriteSocial {
                    TextField("Write a comment…", text: $text, axis: .vertical).lineLimit(2...6).disabled(busy)
                    Button("Comment") { Task { await send(kind: "comment", value: text.trimmingCharacters(in: .whitespacesAndNewlines)) } }.disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > 5000)
                }
                if busy { ProgressView() }
            }.padding(.vertical, 8)
        } label: { Label("Comments & reactions", systemImage: "bubble.left") }
        .task(id: expanded) { if expanded { await load() } }
    }
    private func read(_ service: NativePhotos, after: String? = nil) async throws {
        let result = try await service.request(path + (after.map { "?" + NativePhotos.query(["after": $0]) } ?? ""))
        var opened: [SocialItem] = []
        for row in result["items"].array {
            try PhotoInteractionContract.validate(row, photo: photo)
            opened.append(await model.vault.item(row)); try service.check()
        }
        var currentReaction: SocialItem?
        if result["own_reaction"] != .null {
            let row = result["own_reaction"]; try PhotoInteractionContract.validate(row, photo: photo)
            guard row["author_id"].string == service.member.id, row["kind"].string == "reaction" else { throw PorchError.message("Reaction identity did not match.") }
            currentReaction = await model.vault.item(row); try service.check()
        }
        ownReaction = currentReaction
        rows = after == nil ? opened : rows + opened.filter { item in !rows.contains { $0.id == item.id } }; next = result["next"].string
    }
    private func load(after: String? = nil) async {
        guard !busy else { return }; busy = true; error = ""; defer { busy = false }
        do { try await read(NativePhotos(model), after: after) } catch { rows = []; ownReaction = nil; self.error = error.localizedDescription }
    }
    private func send(kind: String, value: String) async {
        guard !busy else { return }; busy = true; error = ""; defer { busy = false }
        do {
            let service = try NativePhotos(model)
            if kind == "reaction", let own, own.payload?["emoji"].string == value {
                _ = try await service.request(path + "/" + own.id, method: "DELETE"); try await read(service); return
            }
            let key = kind + ":" + value
            if pending == nil || pendingValue != key {
                let context = NativePhotoContract.context(kind: kind, id: UUID().uuidString.lowercased(), parent: photo["id"].string, audience: "photo", album: nil, expiry: NativePhotoContract.expiry(photo["expires_at"]))
                pending = try await service.seal(.object([kind == "comment" ? "text" : "emoji": .string(value)]), context: context, snapshot: path + "/audience"); pendingValue = key
            }
            _ = try await service.request(path, method: "POST", body: .object(["envelope": pending!]))
            pending = nil; if kind == "comment" { text = "" }; try await read(service)
        } catch {
            if case PorchError.api(let code, _, _) = error, ["AUDIENCE_CHANGED", "INVALID_CREATION_TIME"].contains(code) { pending = nil }
            self.error = error.localizedDescription
        }
    }
    private func remove(_ id: String) async {
        guard !busy else { return }; busy = true; error = ""; defer { busy = false }
        do { let service = try NativePhotos(model); _ = try await service.request(path + "/" + id, method: "DELETE"); try await read(service) } catch { self.error = error.localizedDescription }
    }
}

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
    @State private var picker = false
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
    private var choices: [ReactionValue] {
        var seen = Set<String>()
        return reactions.compactMap { row in guard let payload = row.payload, let value = try? ReactionValue.parse(payload), seen.insert(value.id).inserted else { return nil }; return value }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                ScrollView(.horizontal, showsIndicators: false) { HStack {
                    ForEach(choices) { value in
                        let count = reactions.filter { $0.payload?["emoji"].string == value.id }.count
                        Button { Task { await send(kind: "reaction", value: value.id, reaction: value) } } label: {
                            HStack { ReactionGlyph(reaction: value); Text(String(count)) }.padding(8).background(own?.payload?["emoji"].string == value.id ? Color.orange.opacity(0.18) : Color.secondary.opacity(0.07), in: Capsule())
                        }.buttonStyle(.plain).accessibilityLabel("\(value.label), \(count) people").accessibilityValue(own?.payload?["emoji"].string == value.id ? "Selected" : "").disabled(busy || !model.canWriteSocial)
                    }
                    Button { picker = true } label: { Image(systemName: "face.smiling").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("Add reaction").disabled(busy || !model.canWriteSocial)
                } }
                Button { expanded.toggle() } label: { Label("Comment", systemImage: "bubble.left") }
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red); Button("Retry loading") { Task { await load() } }.disabled(busy) }
            if expanded {
                ForEach(rows.filter { $0.raw["kind"].string == "comment" }) { row in
                    VStack(alignment: .leading) {
                        Text("@" + (row.raw["author_handle"].string ?? "member")).font(.headline)
                        Text(row.error ?? row.payload?["text"].string ?? "")
                        if model.canWriteSocial && (row.raw["author_id"].string == model.member?.id || photo["owner_id"].string == model.member?.id) {
                            Button("Delete comment", role: .destructive) { Task { await remove(row.id) } }.disabled(busy)
                        }
                    }
                }
                if model.canWriteSocial {
                    TextField("Write a comment…", text: $text, axis: .vertical).lineLimit(2...6).disabled(busy)
                    Button("Comment") { Task { await send(kind: "comment", value: text.trimmingCharacters(in: .whitespacesAndNewlines)) } }.disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > 5000)
                }
            }
            if let next { Button("Load more comments and reactions") { Task { await load(after: next) } }.disabled(busy) }
            if busy { ProgressView() }
        }
        .task(id: photo["id"]) { await load() }
        .sheet(isPresented: $picker) { NavigationStack { ReactionPicker { value in await send(kind: "reaction", value: value.id, reaction: value); return error.isEmpty } } }
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
    private func send(kind: String, value: String, reaction: ReactionValue? = nil) async {
        guard !busy else { return }; busy = true; error = ""; defer { busy = false }
        do {
            let service = try NativePhotos(model)
            if kind == "reaction", let own, own.payload?["emoji"].string == value {
                _ = try await service.request(path + "/" + own.id, method: "DELETE"); try await read(service); return
            }
            let key = kind + ":" + value
            if pending == nil || pendingValue != key {
                let context = NativePhotoContract.context(kind: kind, id: UUID().uuidString.lowercased(), parent: photo["id"].string, audience: "photo", album: nil, expiry: NativePhotoContract.expiry(photo["expires_at"]))
                pending = try await service.seal(reaction?.payload ?? .object([kind == "comment" ? "text" : "emoji": .string(value)]), context: context, snapshot: path + "/audience"); pendingValue = key
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

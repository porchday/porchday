import SwiftUI
import PhotosUI

struct ReactionGlyph: View {
    let reaction: ReactionValue
    @State private var image: UIImage?
    var body: some View {
        Group {
            if let unicode = reaction.unicode { Text(unicode).font(.title2) }
            else if let image { Image(uiImage:image).resizable().scaledToFit().frame(width:28,height:28) }
            else { Image(systemName:"face.smiling").frame(width:28,height:28) }
        }.accessibilityLabel(reaction.label).task(id:reaction.id) {
            image = nil
            if let data = reaction.png, let decoded = try? ReactionPNG.decode(data), !Task.isCancelled { image = UIImage(cgImage:decoded) }
        }
    }
}
private struct VerifiedReaction {
    let member: String
    let value: ReactionValue
    let tag: String
}
struct ReactionBar: View {
    let item: SocialItem
    let reactions: [JSON]
    let postID: String
    let changed: () async -> Void
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var decoded: [VerifiedReaction] = []
    @State private var decodedContext = ""
    @State private var decoding = UUID()
    @State private var mutation: UUID?
    @State private var picker = false
    @State private var active = true
    @State private var failure = ""
    private var contextKey: String { "\(item.id):\(model.authenticationGeneration):\(model.member?.id ?? ""):\(vault.device?.id ?? ""):\(vault.device?.revoked ?? true)" }
    private var visibleDecoded: [VerifiedReaction] { decodedContext == contextKey && model.member?.access.readsSocial == true ? decoded:[] }
    private var choices: [ReactionValue] {
        var result = reactionCatalog.compactMap { try? ReactionValue.legacy($0.id) }, seen = Set(result.map(\.id))
        for row in visibleDecoded where seen.insert(row.value.id).inserted { result.append(row.value) }
        return result
    }
    var body: some View {
        VStack(alignment:.leading) {
            ScrollView(.horizontal,showsIndicators:false) { HStack {
                ForEach(choices) { value in reactionButton(value) }
                Button { picker = true } label: { Image(systemName:"face.smiling").frame(minWidth:44,minHeight:44) }.accessibilityLabel("Add reaction")
                    .disabled(item.payload == nil || !model.canWriteSocial || mutation != nil)
            } }
            if !failure.isEmpty { Text(failure).font(.caption).foregroundStyle(.secondary).accessibilityLabel(failure) }
        }
        .onAppear { active = true }.onDisappear { active = false; decoding = UUID(); decoded = [] }
        .task(id:contextKey + ((try? JSON.array(reactions).serialized()) ?? "")) { await decode() }
        .sheet(isPresented:$picker) { NavigationStack { ReactionPicker { value in await toggle(value) } } }
    }
    private func reactionButton(_ value: ReactionValue) -> some View {
        let rows = visibleDecoded.filter { $0.value.id == value.id }, count = Set(rows.map(\.member)).count, selected = rows.contains { $0.member == model.member?.id }
        return Button { Task { _ = await toggle(value) } } label: {
            HStack(spacing:4) { ReactionGlyph(reaction:value); if count > 0 { Text(String(count)) } }
                .padding(.horizontal,8).frame(minHeight:44).background(selected ? Color.orange.opacity(0.18):Color.secondary.opacity(0.07),in:Capsule())
        }.buttonStyle(.plain).accessibilityLabel("\(value.label), \(count) people").accessibilityAddTraits(selected ? .isSelected:[])
            .disabled(item.payload == nil || !model.canWriteSocial || mutation != nil)
            .contextMenu {
                if value.isCustom { Button("Save emoji to my collection") { Task { await save(value) } }.disabled(!model.canWriteSocial || mutation != nil) }
            }
    }
    private func decode() async {
        let ticket = UUID(), capturedContext = contextKey; decoding = ticket; decoded = []; decodedContext = ""
        guard model.member?.access.readsSocial == true, let session = try? ReactionSession(model), let secret = item.payload?["reactionSecret"].string else { return }
        var valid: [VerifiedReaction] = [], seen = Set<String>()
        for raw in reactions {
            do {
                try session.require(model); try Task.checkCancellation()
                let payload = try await vault.open(raw), value = try ReactionValue.parse(payload), context = raw["envelope"]["context"]
                guard let member = raw["member_id"].string, let tag = raw["reaction_tag"].string,
                      context["kind"].string == "reaction", context["authorId"].string == member, context["parentId"].string == item.id,
                      context["id"].string == tag, context["audience"] == item.context["audience"], context["groupId"] == item.context["groupId"],
                      PorchDate.minimum([raw["effective_expires_at"],context["expiresAt"]]).map({$0 > Date()}) ?? true,
                      try CryptoVault.tag(secret:secret,target:item.id,member:member,emoji:value.id) == tag,
                      seen.insert(member + ":" + value.id).inserted else { continue }
                valid.append(VerifiedReaction(member:member,value:value,tag:tag))
            } catch { if Task.isCancelled || !session.current(model) { return } }
        }
        if active, decoding == ticket, capturedContext == contextKey, session.current(model), !Task.isCancelled { decoded = valid; decodedContext = capturedContext }
    }
    private func toggle(_ value: ReactionValue) async -> Bool {
        guard active, mutation == nil, item.active, let session = try? ReactionSession(model), let member = model.member, let secret = item.payload?["reactionSecret"].string else { return false }
        let ticket = UUID(); mutation = ticket; failure = ""
        defer { if mutation == ticket { mutation = nil } }
        do {
            try session.require(model,write:true)
            let tag = try CryptoVault.tag(secret:secret,target:item.id,member:member.id,emoji:value.id)
            let path = "/\(item.isComment ? "comments":"posts")/\(item.id)/reactions/\(tag)"
            if visibleDecoded.contains(where:{$0.member == member.id && $0.value.id == value.id}) {
                _ = try await model.api.social(path,method:"DELETE")
            } else {
                let envelope = try await vault.seal(value.payload,member:member,kind:"reaction",audience:item.context["audience"].string ?? "connections",id:tag,group:item.context["groupId"].string,parent:item.id,post:postID,expiry:item.expiry)
                try session.require(model,write:true); guard active, item.active else { throw CancellationError() }
                _ = try await model.api.social(path,method:"PUT",body:.object(["envelope":envelope]))
            }
            guard active, session.current(model) else { return false }
            await changed(); return true
        } catch { if active, session.current(model), !(error is CancellationError) { failure = reactionError(error) }; return false }
    }
    private func save(_ value: ReactionValue) async {
        guard active, mutation == nil, let session = try? ReactionSession(model) else { return }
        let ticket = UUID(); mutation = ticket; defer { if mutation == ticket { mutation = nil } }
        do { _ = try await model.mergeEmojiLibrary([value],session:session); if active, session.current(model) { failure = "Emoji saved to your collection." } }
        catch { if active, session.current(model), !(error is CancellationError) { failure = error.localizedDescription } }
    }
    private func reactionError(_ error: Error) -> String {
        if case PorchError.api(let code, _, _) = error {
            if code == "REACTION_LIMIT" { return "You can add up to 20 different reactions here. Remove one before adding another." }
            if code == "REACTION_STORAGE_LIMIT" { return "This conversation has reached its reaction storage limit." }
        }
        return error.localizedDescription
    }
}

struct ReactionPicker: View {
    var selected: ((ReactionValue) async -> Bool)?
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var input = ""
    @State private var name = ""
    @State private var photo: PhotosPickerItem?
    @State private var prepared: Data?
    @State private var saved: [ReactionValue] = []
    @State private var available = false
    @State private var busy = false
    @State private var message = ""
    @State private var active = true
    @State private var loadID = UUID()
    @State private var limit = 80
    @State private var stateContext = ""
    private var contextKey: String { "\(model.authenticationGeneration):\(model.member?.id ?? ""):\(vault.device?.id ?? "")" }
    private var matches: [UnicodeReactionEntry] {
        let term = search.trimmingCharacters(in:.whitespacesAndNewlines)
        return term.isEmpty ? UnicodeReactions.entries:UnicodeReactions.entries.filter { $0.name.localizedCaseInsensitiveContains(term) || $0.group.localizedCaseInsensitiveContains(term) || $0.unicode == term }
    }
    var body: some View {
        Form {
            if stateContext != contextKey { ProgressView("Loading emoji…") }
            else {
            if !message.isEmpty { Section { Text(message).foregroundStyle(.secondary) } }
            if selected != nil {
                Section("Emoji") {
                    TextField("Type or paste one emoji",text:$input).autocorrectionDisabled().textInputAutocapitalization(.never)
                    Button("Use emoji") { Task { do { await choose(try ReactionValue.emoji(input)) } catch { message = error.localizedDescription } } }.disabled(busy || input.isEmpty)
                    TextField("Search emoji",text:$search).onChange(of:search) { _,_ in limit = 80 }
                    ForEach(Array(matches.prefix(limit))) { entry in
                        Button { Task { if let value = try? ReactionValue.emoji(entry.unicode) { await choose(value) } } } label: { HStack { Text(entry.unicode).font(.title2); Text(entry.name) }.frame(minHeight:44) }.disabled(busy)
                    }
                    if matches.count > limit { Button("Show more emoji") { limit += 80 } }
                }
            }
            Section("Saved custom emoji") {
                if !available { Button("Load collection") { Task { await load() } }.disabled(busy) }
                else if saved.isEmpty { Text("No saved custom emoji.").foregroundStyle(.secondary) }
                ForEach(saved) { value in
                    HStack {
                        if selected != nil { Button { Task { await choose(value) } } label: { HStack { ReactionGlyph(reaction:value); Text(value.label) }.frame(minHeight:44) }.disabled(busy) }
                        else { ReactionGlyph(reaction:value); Text(value.label) }
                        Spacer(); Button("Remove",role:.destructive) { Task { await remove(value) } }.disabled(busy || !model.canWriteSocial)
                    }
                }
            }
            if model.canWriteSocial {
                Section("Upload custom emoji") {
                    PhotosPicker(selection:$photo,matching:.images) { Label("Choose image",systemImage:"photo").frame(minHeight:44) }.disabled(busy)
                    if let prepared, let image = try? ReactionPNG.decode(prepared) { Image(uiImage:UIImage(cgImage:image)).resizable().scaledToFit().frame(width:64,height:64) }
                    TextField("Name: lowercase letters, numbers, underscores",text:$name).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("A still image up to 128 × 128 pixels. Saved privately; people who can see a reaction can reuse its emoji.").font(.footnote)
                    Button("Save to collection") { Task { await savePrepared() } }.disabled(busy || prepared == nil || name.isEmpty)
                }
            }
            }
        }.navigationTitle(selected == nil ? "Custom emoji":"Add reaction")
            .toolbar { if selected != nil { Button("Done") { dismiss() } } }
            .onAppear { active = true }.onDisappear { active = false; loadID = UUID(); prepared = nil; saved = [] }
            .task(id:contextKey) { await load() }
            .task(id:photo) { await preparePhoto() }
    }
    private func load() async {
        if stateContext != contextKey { prepared = nil; photo = nil; name = ""; input = ""; message = ""; stateContext = contextKey }
        let ticket = UUID(); loadID = ticket; available = false; saved = []
        guard let session = try? ReactionSession(model) else { return }
        do { let result = try await model.readEmojiLibrary(session:session); if active, loadID == ticket, session.current(model), !Task.isCancelled { saved = result.entries; available = true } }
        catch { if active, loadID == ticket, session.current(model), !(error is CancellationError) { message = error.localizedDescription } }
    }
    private func choose(_ value: ReactionValue) async {
        guard active, !busy, let selected else { return }; busy = true; defer { busy = false }
        if await selected(value), active { dismiss() }
    }
    private func preparePhoto() async {
        prepared = nil; guard let selection = photo, let session = try? ReactionSession(model) else { return }
        do {
            guard let bytes = try await selection.loadTransferable(type:Data.self) else { return }
            try session.require(model,write:true); guard active, !Task.isCancelled else { return }
            let result = try EmojiImage.prepare(bytes)
            if active, photo == selection, session.current(model), !Task.isCancelled { prepared = result }
        } catch { if active, session.current(model), !(error is CancellationError) { message = error.localizedDescription } }
    }
    private func savePrepared() async {
        guard !busy, let prepared, let session = try? ReactionSession(model) else { return }; busy = true; defer { busy = false }
        do {
            let value = try ReactionValue.custom(name:name,png:prepared), entries = try await model.mergeEmojiLibrary([value],session:session)
            if active, session.current(model) { saved = entries; available = true; self.prepared = nil; photo = nil; name = ""; message = "Emoji saved." }
        } catch { if active, session.current(model), !(error is CancellationError) { message = error.localizedDescription } }
    }
    private func remove(_ value: ReactionValue) async {
        guard !busy, let session = try? ReactionSession(model) else { return }; busy = true; defer { busy = false }
        do {
            let latest = try await model.readEmojiLibrary(session:session), remaining = latest.entries.filter { $0.id != value.id }
            try await model.writeEmojiLibrary(remaining,replacing:latest,session:session)
            if active, session.current(model) { saved = remaining; available = true; message = "Removed from your collection. Existing reactions are unchanged." }
        } catch { if active, session.current(model), !(error is CancellationError) { message = error.localizedDescription } }
    }
}

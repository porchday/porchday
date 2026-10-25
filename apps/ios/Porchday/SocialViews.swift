import SwiftUI
import PhotosUI
import ImageIO
import UniformTypeIdentifiers

struct FeedView: View {
    let title: String
    let endpoint: String
    var showComposer = false
    var groupID: String?
    var profileHeader: AnyView?
    var wallpaper: ProfileWallpaper = .none
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var rows: [SocialItem] = []
    @State private var cursor: String?
    @State private var busy = false
    @State private var compose = false
    @State private var loaded = false
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            List {
                if let profileHeader { Section { profileHeader } }
                if showComposer { Section { Button { compose = true } label: { Label("Share a little of your day", systemImage: "square.and.pencil").padding(.vertical, 8) } } }
                Section {
                    if loaded && rows.filter(\.active).isEmpty { ContentUnavailableView("A quiet start", systemImage: "sun.max", description: Text("Connect with your people. Their moments will appear here, with no suggested posts or ads.")) }
                    ForEach(rows.filter(\.active)) { item in NavigationLink { PostDetailView(id: item.id) } label: { MomentCard(item: item) } }
                    if cursor != nil { Button("Load more moments") { Task { await load(more: true) } }.disabled(busy) }
                    else if loaded && !rows.isEmpty { Text("You’re all caught up. There’s a whole day out there.").font(.footnote).foregroundStyle(.secondary) }
                    if busy { ProgressView() }
                } header: {
                    if wallpaper == .none { Text("Your people, newest first") }
                    else { Text("Your people, newest first").foregroundStyle(.primary).padding(8).background(.background, in: RoundedRectangle(cornerRadius: 6)) }
                }
            }
            .scrollContentBackground(wallpaper == .none ? .visible : .hidden)
            .background { if wallpaper != .none { WallpaperBackground(wallpaper: wallpaper).ignoresSafeArea(edges: .bottom) } }
        }
        .navigationTitle(title).refreshable { await load() }.task(id: endpoint) { await load() }
        .toolbar { NavigationLink { NotificationsView() } label: { Label("Notifications", systemImage: "bell") } }
        .sheet(isPresented: $compose) { NavigationStack { ComposerView(groupID: groupID) { Task { await load() } } } }
    }
    private func load(more: Bool = false) async {
        busy = true; defer { busy = false }
        await model.perform {
            let suffix = more ? "?cursor=" + (cursor ?? "").addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)! : ""
            let result = try await model.api.social(endpoint + suffix)
            var items: [SocialItem] = []; for raw in result["items"].array { items.append(await vault.item(raw)) }
            rows = more ? rows + items.filter { next in !rows.contains { $0.id == next.id } } : items
            cursor = result["next_cursor"].string; loaded = true
        }
    }
}
struct MomentCard: View {
    let item: SocialItem
    @EnvironmentObject var model: AppModel
    var body: some View { VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .top) { Image(systemName: "person.crop.circle.fill").font(.title).foregroundStyle(.secondary); VStack(alignment: .leading) { Text(item.authorID == model.member?.id ? "@\(model.member?.handle ?? "")" : item.authorHandle).font(.headline); if let date = item.created { Text(date, style: .relative).font(.caption).foregroundStyle(.secondary) } }; Spacer(); Image(systemName: "lock.fill").font(.caption).accessibilityLabel("End-to-end encrypted") }
        if let expiry = item.expiry { Label("Disappears \(expiry.formatted(date: .abbreviated, time: .shortened))", systemImage: "timer").font(.caption).foregroundStyle(.secondary) }
        if let error = item.error { Label(error, systemImage: "lock.trianglebadge.exclamationmark").font(.callout).foregroundStyle(.secondary) } else { Text(item.text).font(.body).textSelection(.enabled); if let media = item.payload?["media"].array { ForEach(Array(media.enumerated()), id: \.offset) { _, photo in EncryptedPhotoView(photo: photo) } } }
    }.padding(.vertical, 10) }
}
struct PostDetailView: View {
    let id: String
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var post: SocialItem?
    @State private var comments: [SocialItem] = []
    @State private var reactions: [JSON] = []
    @State private var commentReactions: [JSON] = []
    @State private var reply: SocialItem?
    @State private var report: SocialItem?
    @State private var edit: SocialItem?
    @State private var removing: SocialItem?
    @State private var resharing: SocialItem?
    @State private var mayModerate = false
    @State private var deleted = false
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            List {
                if let post, post.active, !deleted {
                    Section { MomentCard(item: post); ReactionBar(item: post, reactions: reactions, postID: id, changed: refresh); Button("Write a comment") { reply = post } }
                    if post.authorID == model.member?.id || mayModerate { Section { if post.authorID == model.member?.id { Button("Edit or shorten timer") { edit = post }; Button("Share with current audience again") { resharing = post } }; Button("Delete post and comments", role: .destructive) { removing = post } } }
                    Section("Comments") {
                        ForEach(threadedComments) { item in VStack(alignment: .leading, spacing: 8) {
                            if let parent = item.raw["parent_id"].string { Label("Reply in thread", systemImage: "arrow.turn.down.right").font(.caption).accessibilityHint("Reply to comment \(parent)") }
                            MomentCard(item: item)
                            ReactionBar(item: item, reactions: commentReactions.filter { $0["comment_id"].string == item.id }, postID: id, changed: refresh)
                            HStack { Button("Reply") { reply = item }; Button("Report") { report = item };if item.authorID == model.member?.id { Button("Edit") { edit = item } }; if item.authorID == model.member?.id || post.authorID == model.member?.id || mayModerate { Button("Delete", role: .destructive) { removing = item } } } }.padding(.leading, item.raw["parent_id"].string == nil ? 0 : 12) }
                    }
                    Section { Button("Report a concern") { report = post } }
                } else { ContentUnavailableView("This moment isn’t here", systemImage: "clock", description: Text("It may have expired, been removed, or no longer be shared with you.")) }
            }
        }.navigationTitle("A moment together").navigationBarTitleDisplayMode(.inline).task(id: id) { await refresh() }.refreshable { await refresh() }
            .confirmationDialog("Delete this content and its replies?",isPresented:Binding(get:{removing != nil},set:{if !$0 { removing=nil }}),titleVisibility:.visible) {
                Button("Delete permanently",role:.destructive) { guard let item=removing else{return};Task { await model.perform { _ = try await model.api.social("/"+(item.isComment ? "comments/":"posts/")+item.id,method:"DELETE");if item.isComment { await refresh() } else { deleted=true };removing=nil } } }
                Button("Cancel",role:.cancel) { removing=nil }
            } message: { Text("Saved copies cannot be recalled.") }
            .sheet(item: $reply) { item in if let post { NavigationStack { ComposerView(post: post, parent: item) { Task { await refresh() } } } } }
            .sheet(item: $edit) { item in NavigationStack { EditContentView(item: item, postID: id) { Task { await refresh() } } } }
            .sheet(item: $resharing) { item in NavigationStack { ResharePostView(item: item) { Task { await refresh() } } } }
            .sheet(item: $report) { item in NavigationStack { ReportView(item: item) } }
    }
    private var threadedComments: [SocialItem] {
        let active = comments.filter(\.active); var result: [SocialItem] = [], seen = Set<String>()
        func append(_ parent: String?) { for item in active where item.raw["parent_id"].string == parent && !seen.contains(item.id) { seen.insert(item.id); result.append(item); append(item.id) } }; append(nil)
        return result
    }
    private func refresh() async { await model.perform { let data = try await model.api.social("/posts/" + id); post = await vault.item(data["post"]); var decoded: [SocialItem] = []; for raw in data["comments"].array { decoded.append(await vault.item(raw)) }; comments = decoded; reactions = data["reactions"].array; commentReactions = data["comment_reactions"].array
        mayModerate = false
        if let group = post?.context["groupId"].string, let details = try? await model.api.social("/groups/" + group) {
            mayModerate = details["members"].array.contains { $0["member_id"].string == model.member?.id && ["owner", "moderator"].contains($0["role"].string ?? "") }
        }
    } }
}
struct ReactionBar: View {
    let item: SocialItem
    let reactions: [JSON]
    let postID: String
    let changed: () async -> Void
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var decoded: [(member: String, emoji: String, tag: String)] = []
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) { HStack {
            ForEach(reactionCatalog, id: \.id) { entry in
                let values = decoded.filter { $0.emoji == entry.id }, count = Set(values.map(\.member)).count, selected = values.contains { $0.member == model.member?.id }
                Button { Task { await toggle(entry.id) } } label: { Text(entry.emoji + (count > 0 ? " \(count)" : "")).padding(8).background(selected ? Color.green.opacity(0.15) : Color.secondary.opacity(0.07), in: Capsule()) }
                    .buttonStyle(.plain).accessibilityLabel("\(entry.label), \(count) people").accessibilityAddTraits(selected ? .isSelected : []).disabled(item.payload == nil)
            }
        } }.task(id: try? JSON.array(reactions).serialized()) { await decode() }
    }
    private func decode() async {
        guard let secret = item.payload?["reactionSecret"].string else { return }; var valid: [(String, String, String)] = [], seen = Set<String>()
        for raw in reactions { do { let payload = try await vault.open(raw), member = raw["member_id"].string ?? raw["envelope"]["context"]["authorId"].string ?? "", emoji = payload["emoji"].string ?? "", tag = raw["reaction_tag"].string ?? ""; guard raw["envelope"]["context"]["authorId"].string == member, raw["envelope"]["context"]["parentId"].string == item.id, raw["envelope"]["context"]["id"].string == tag, reactionCatalog.contains(where: { $0.id == emoji }), try CryptoVault.tag(secret: secret, target: item.id, member: member, emoji: emoji) == tag, seen.insert(member + ":" + emoji).inserted else { continue }; valid.append((member, emoji, tag)) } catch { continue } }; decoded = valid
    }
    private func toggle(_ emoji: String) async { await model.perform {
        guard let member = model.member, let secret = item.payload?["reactionSecret"].string else { return }; let tag = try CryptoVault.tag(secret: secret, target: item.id, member: member.id, emoji: emoji)
        let path = "/\(item.isComment ? "comments" : "posts")/\(item.id)/reactions/\(tag)"
        if decoded.contains(where: { $0.member == member.id && $0.emoji == emoji }) { _ = try await model.api.social(path, method: "DELETE") }
        else { let envelope = try await vault.seal(.object(["emoji": .string(emoji)]), member: member, kind: "reaction", audience: item.context["audience"].string ?? "connections", id: tag, group: item.context["groupId"].string, parent: item.id, post: postID, expiry: item.expiry); _ = try await model.api.social(path, method: "PUT", body: .object(["envelope": envelope])) }
        await changed()
    } }
}
struct ComposerView: View {
    var groupID: String?
    var post: SocialItem?
    var parent: SocialItem?
    let submitted: () -> Void
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var audience = "connections"
    @State private var timer = 0
    @State private var busy = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var photos: [PreparedPhoto] = []
    @State private var camera = false
    @State private var observedExpiry:Date?
    private var inheritedExpiry: Date? { observedExpiry ?? parent?.expiry ?? post?.expiry }
    var body: some View { Form {
        if let expiry = inheritedExpiry { Section { Label("This comment will be deleted with its parent on \(expiry.formatted(date: .abbreviated, time: .shortened)). You can make its timeout shorter.", systemImage: "timer").font(.callout) } }
        Section { TextEditor(text: $text).frame(minHeight: 130).accessibilityLabel(post == nil ? "Write a post" : "Write a comment"); Text("\(text.count)/5,000 characters").font(.caption).foregroundStyle(.secondary) }
        if post == nil { Section { if groupID == nil { Picker("Share with", selection: $audience) { Text("Friends & family").tag("connections"); Text("Family only").tag("family"); Text("Only me").tag("only_me") } }; PhotosPicker(selection: $photoSelection, maxSelectionCount: 10, matching: .images) { Label("Add photos", systemImage: "photo") }; if UIImagePickerController.isSourceTypeAvailable(.camera) { Button("Take a photo") { camera = true } }; ForEach($photos) { $photo in VStack { if let image = UIImage(data: photo.bytes) { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 150) }; TextField("Photo description (alt text)", text: $photo.alt) } } } }
        Section { Picker("Delete after", selection: $timer) { Text(inheritedExpiry == nil ? "No timer" : "Same timeout as parent").tag(0); ForEach([3600,86400,604800,2592000], id: \.self) { seconds in if inheritedExpiry == nil || Date().addingTimeInterval(Double(seconds)) < inheritedExpiry! { Text(seconds == 3600 ? "1 hour" : seconds == 86400 ? "24 hours" : seconds == 604800 ? "7 days" : "30 days").tag(seconds) } } }; Button(busy ? "Encrypting and sharing…" : post == nil ? "Share moment" : "Comment") { Task { await submit() } }.disabled(busy || text.count > 5000 || (text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && photos.isEmpty)) }
    }.navigationTitle(post == nil ? "Share a little of your day" : "Leave a comment").navigationBarTitleDisplayMode(.inline).toolbar { Button("Cancel") { dismiss() } }
        .onChange(of: photoSelection) { _, values in Task { await model.perform { var selected: [PreparedPhoto] = []; for item in values { if let bytes = try await item.loadTransferable(type: Data.self) { selected.append(try PhotoPipeline.prepare(bytes)) } }; photos = selected } } }
        .sheet(isPresented: $camera) { CameraView { image in Task { await model.perform { guard let data = image.jpegData(compressionQuality: 0.9) else { return }; photos.append(try PhotoPipeline.prepare(data)) } }; camera = false } }
    }
    private func submit() async { busy = true; defer { busy = false }; await model.perform {
        guard let member = model.member else { return }; let id = UUID().uuidString.lowercased(), expiry = PorchDate.deadline(seconds: timer, parent: inheritedExpiry), share = post?.context["audience"].string ?? (groupID == nil ? audience : "group"), group = groupID ?? post?.context["groupId"].string
        var media: [JSON] = []
        for photo in photos {
            media.append(try await model.uploadSurfacePhoto(photo, audience: share, parent: id, group: group, expiry: expiry))
        }
        let payload: JSON = .object(["text": .string(text.trimmingCharacters(in: .whitespacesAndNewlines)), "reactionSecret": .string(try CryptoVault.randomSecret()), "media": .array(media)])
        let envelope = try await vault.seal(payload, member: member, kind: post == nil ? "post" : "comment", audience: share, id: id, group: group, parent: parent?.id, post: post?.id, expiry: expiry)
        if let post {
            do { _ = try await model.api.social("/posts/\(post.id)/comments", method:"POST",body:.object(["envelope":envelope,"parent_expires_at":inheritedExpiry.map{.string(PorchDate.string($0))} ?? .null])) }
            catch PorchError.api(let code,_,let details) where code=="PARENT_DEADLINE_CHANGED" {
                observedExpiry=details["expires_at"].string.flatMap(PorchDate.parse)
                throw PorchError.message("The parent's timer changed. Review the updated inherited timeout above, then submit again.")
            }
        }
        else { _ = try await model.api.social("/posts", method: "POST", body: .object(["envelope": envelope, "media_ids": .array(media.map { $0["id"] })])) }
        submitted(); dismiss()
    } }
}
struct EditContentView: View {
    let item: SocialItem; let postID: String; let submitted: () -> Void
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var timer = 0
    var body: some View { Form { TextEditor(text: $text).frame(minHeight: 150); if let expiry = item.expiry { Text("Current deadline: \(expiry.formatted()). It can only be shortened.") }; Picker("Shorter timeout", selection: $timer) { Text("Keep current timeout").tag(0); Text("One hour from now").tag(3600) }; Button("Save changes") { Task { await model.perform { guard let member = model.member, var payload = item.payload else { return }; payload = payload.replacing("text", with: .string(text)); let context = item.context.replacing("revision", with: .number(Double((item.context["revision"].integer ?? 1) + 1))); let deadline = PorchDate.deadline(seconds: timer, parent: item.expiry); let envelope = try await vault.seal(payload, member: member, kind: item.context["kind"].string ?? "post", audience: item.context["audience"].string ?? "connections", id: item.id, group: item.context["groupId"].string, parent: item.context["parentId"].string, post: postID, expiry: deadline, original: context); let proof = try vault.sign(.object(["purpose": .string("porchday-lifecycle"), "id": .string(item.id), "revision": envelope["context"]["revision"], "expiresAt": envelope["context"]["expiresAt"]])); _ = try await model.api.social("/\(item.isComment ? "comments" : "posts")/\(item.id)", method: "PUT", body: .object(["envelope": envelope, "lifecycle": proof])); submitted(); dismiss() } } }.disabled(text.count > 5000) }.navigationTitle("Edit moment").task { text = item.text }.toolbar { Button("Cancel") { dismiss() } } }
}

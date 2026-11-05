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
    @State private var loadID = UUID()
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            List {
                if let notice = model.member?.access.notice { Section { Text(notice) } }
                if let profileHeader { Section { profileHeader } }
                if showComposer && model.canWriteSocial { Section { Button { compose = true } label: { Label("New post", systemImage: "square.and.pencil").padding(.vertical, 8) } } }
                Section {
                    if loaded && rows.filter(\.active).isEmpty { ContentUnavailableView("No posts yet", systemImage: "sun.max", description: Text("Posts shared with you appear here.")) }
                    ForEach(rows.filter(\.active)) { item in NavigationLink { PostDetailView(id: item.id) } label: { MomentCard(item: item) } }
                    if cursor != nil { Button("Load more posts") { Task { await load(more: true) } }.disabled(busy) }
                    if busy { ProgressView() }
                } header: {
                    if wallpaper == .none { Text("Newest first") }
                    else { Text("Newest first").foregroundStyle(.primary).padding(8).background(.background, in: RoundedRectangle(cornerRadius: 6)) }
                }
            }
            .scrollContentBackground(wallpaper == .none ? .visible : .hidden)
            .background { if wallpaper != .none { WallpaperBackground(wallpaper: wallpaper).ignoresSafeArea(edges: .bottom) } }
        }
        .navigationTitle(title).refreshable { await load() }.task(id: endpoint) { await load() }
        .onChange(of: model.historySharingVersion) { _, _ in Task { await load() } }
        .toolbar { NavigationLink { NotificationsView() } label: { Label("Notifications", systemImage: "bell") } }
        .sheet(isPresented: $compose) { NavigationStack { ComposerView(groupID: groupID) { Task { await load() } } } }
    }
    @MainActor private func load(more: Bool = false) async {
        if more && busy { return }
        guard let memberID = model.member?.id, vault.unlocked else { return }
        let authenticationGeneration = model.authenticationGeneration
        let deviceID = vault.device?.id
        let attempt = UUID()
        loadID = attempt
        busy = true
        defer { if loadID == attempt { busy = false } }
        let current: @MainActor @Sendable () -> Bool = {
            loadID == attempt && model.member?.id == memberID &&
                model.authenticationGeneration == authenticationGeneration &&
                vault.device?.id == deviceID && vault.unlocked && !Task.isCancelled
        }
        await model.perform {
            let suffix = more ? "?cursor=" + (cursor ?? "").addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)! : ""
            let result = try await model.api.social(endpoint + suffix)
            guard current() else { return }
            let existing = more ? rows : []
            if !more { rows = []; cursor = nil; loaded = false }
            let complete = await ProgressiveFeed.decode(result["items"].array, isCurrent: current, open: { await vault.item($0) }, publish: { items in
                rows = existing + items.filter { next in !existing.contains { $0.id == next.id } }
                loaded = true
            })
            guard complete, current() else { return }
            cursor = result["next_cursor"].string
            loaded = true
        }
    }
}
struct MomentCard: View {
    let item: SocialItem
    @EnvironmentObject var model: AppModel
    var body: some View { VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .top) { MemberAvatarView(memberID: item.authorID, name: item.authorHandle); VStack(alignment: .leading) { Text(item.authorID == model.member?.id ? "@\(model.member?.handle ?? "")" : item.authorHandle).font(.headline); if let date = item.created { Text(date, style: .relative).font(.caption).foregroundStyle(.secondary) } }; Spacer(); Image(systemName: "lock.fill").font(.caption).accessibilityLabel("End-to-end encrypted") }
        if let expiry = item.expiry { Label("Disappears \(DisplayPreferences.date(expiry))", systemImage: "timer").font(.caption).foregroundStyle(.secondary) }
        if let error = item.error { Label(error, systemImage: "lock.trianglebadge.exclamationmark").font(.callout).foregroundStyle(.secondary) } else { Text(item.text).font(.body).textSelection(.enabled); PeopleTagsView(tags: PersonTag.parse(item.payload?["tags"] ?? .null)); if let payload = item.payload, payload["provenance"]["kind"].string == "reaction", let reaction = try? ReactionValue.parse(.object(payload.object.filter { ["emoji","unicode","custom"].contains($0.key) })) { ReactionGlyph(reaction:reaction) }; if let media = item.payload?["media"].array { ForEach(Array(media.enumerated()), id: \.offset) { _, photo in EncryptedMediaView(media: photo) } } }
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
                    Section { MomentCard(item: post); ReactionBar(item: post, reactions: reactions, postID: id, changed: refresh); Button("Write a comment") { reply = post }.disabled(!model.canWriteSocial) }
                    if model.canWriteSocial && (post.authorID == model.member?.id || mayModerate) { Section { if post.authorID == model.member?.id { Button("Edit or shorten timer") { edit = post }; Button("Share with current audience again") { resharing = post } }; Button("Delete post and comments", role: .destructive) { removing = post } } }
                    Section("Comments") {
                        ForEach(threadedComments) { item in VStack(alignment: .leading, spacing: 8) {
                            if let parent = item.raw["parent_id"].string { Label("Reply in thread", systemImage: "arrow.turn.down.right").font(.caption).accessibilityHint("Reply to comment \(parent)") }
                            MomentCard(item: item)
                            ReactionBar(item: item, reactions: commentReactions.filter { $0["comment_id"].string == item.id }, postID: id, changed: refresh)
                            HStack { Button("Reply") { reply = item }.disabled(!model.canWriteSocial); Button("Report") { report = item };if model.canWriteSocial && item.authorID == model.member?.id { Button("Edit") { edit = item } }; if model.canWriteSocial && (item.authorID == model.member?.id || post.authorID == model.member?.id || mayModerate) { Button("Delete", role: .destructive) { removing = item } } } }.padding(.leading, item.raw["parent_id"].string == nil ? 0 : 12) }
                    }
                    Section { Button("Report a concern") { report = post } }
                } else { ContentUnavailableView("Post unavailable", systemImage: "clock", description: Text("It may have expired, been removed, or no longer be shared with you.")) }
            }
        }.navigationTitle("Post").porchInlineTitle().task(id: id) { await refresh() }.refreshable { await refresh() }
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
struct ComposerView: View {
    var initialAlbum: String?
    var shareTabs = false
    var groupID: String?
    var post: SocialItem?
    var parent: SocialItem?
    let submitted: () -> Void
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var audience = "connections"
    @State private var photosOnly = false
    @State private var album = ""
    @State private var albums: [NativeAlbum] = []
    @State private var completedPhotos: Set<String> = []
    @State private var timer = 0
    @State private var busy = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var photos: [PreparedPhoto] = []
    @StateObject private var people = PeopleDirectory()
    @State private var tags: [PersonTag] = []
    @State private var onBehalf = ""
    @State private var camera = false
    @State private var videoFilePicker = false
    @State private var observedExpiry: Date?
    @State private var observedPostExpiry: Date?
    @State private var customExpiry = Date().addingTimeInterval(900)
    @State private var parentUnavailable = false
    private var deadlineContext: CommentDeadline {
        CommentDeadline(postExpiry: observedPostExpiry ?? post?.expiry,
                        parentExpiry: observedExpiry ?? parent?.expiry, isReply: parent?.isComment == true)
    }
    private var timerChoice: ComposerTimerChoice { timer == -1 ? .custom(customExpiry) : timer == 0 ? .inherit : .after(timer) }
    var body: some View { Form {
        if shareTabs { Picker("Share", selection: $photosOnly) { Text("Post").tag(false); Text("Photos").tag(true) }.pickerStyle(.segmented) }
        if let member = model.member { HStack { MemberAvatarView(memberID: member.id, name: member.handle); Text("@" + member.handle) } }
        if !photosOnly { Section { TextEditor(text: $text).frame(minHeight: 130).accessibilityLabel(post == nil ? "Write a post" : "Write a comment"); Text("Use @handle to mention a connection. \(text.count)/5,000 characters").font(.caption).foregroundStyle(.secondary) } }
        if !photosOnly { Section { PeopleTagPicker(tags: $tags, directory: people) } }
        if post == nil && !photosOnly { Section { Picker("Posting on behalf of", selection: $onBehalf) { Text("Myself").tag(""); ForEach(people.children.filter { $0.raw["can_post"].boolean }) { Text($0.name).tag($0.id) } }; Text("You remain the author. Posting on a child’s behalf tags them without expanding the audience.").font(.caption) } }
        if shareTabs && !photosOnly { Section { Text("Add Photos to this Post").font(.headline); HStack(spacing: 0) { Text("(Skip the post and "); Button("add photos directly") { photosOnly = true }.buttonStyle(.plain); Text(")") }.font(.caption) } }
        if photosOnly { Section { Picker("Album", selection: $album) { Text("No album").tag(""); ForEach(albums) { Text($0.name).tag($0.id) } }; Text("Album access adds to the audience you choose below.").font(.caption) } }
        if post == nil { Section { if groupID == nil { Picker("Share with", selection: $audience) { ForEach(SharingAudience.allCases) { Text($0.label).tag($0.rawValue) } }; if audience == SharingAudience.friends.rawValue { Text("Excludes connections labeled family.").font(.footnote).foregroundStyle(.secondary) } }; PhotosPicker(selection: $photoSelection, maxSelectionCount: 10, matching: .any(of: [.images, .videos])) { Label("Add photos or videos", systemImage: "photo.on.rectangle") }; Button("Add video from Files") { videoFilePicker = true }; if ApplePlatform.cameraAvailable { Button("Take a photo") { camera = true } }; ForEach($photos) { $photo in VStack { if photosOnly { TextField("Photo date (YYYY-MM-DD)", text: $photo.photoDate) }; if let image = PlatformImage(data: photo.bytes) { Image(platformImage: image).resizable().scaledToFit().frame(maxHeight: 150) }; TextField("Caption", text: $photo.alt); if !photo.caption.isEmpty { TextField("Additional caption", text: $photo.caption) }; PeopleTagPicker(tags: $photo.tags, directory: people) } } } }
        Section {
            TimelineView(.periodic(from: .now, by: 1)) { timeline in
                VStack(alignment: .leading, spacing: 12) {
                    if let warning = deadlineContext.warning(now: timeline.date) { InheritedDeadlineNotice(message: warning) }
                    Picker("Expiration", selection: $timer) {
                        Text(deadlineContext.inherited == nil ? "No timer" : "Same expiration as parent").tag(0)
                        ForEach([3600,86400,604800,2592000], id: \.self) { seconds in
                            if timer == seconds || deadlineContext.inherited == nil || timeline.date.addingTimeInterval(Double(seconds)) <= deadlineContext.inherited! {
                                Text(seconds == 3600 ? "1 hour" : seconds == 86400 ? "24 hours" : seconds == 604800 ? "7 days" : "30 days").tag(seconds)
                            }
                        }
                        Text(deadlineContext.inherited == nil ? "Choose a custom time" : "Choose a shorter timeout").tag(-1)
                    }
                    .accessibilityIdentifier("composer-expiration")
                    if timer == -1 {
                        let upper = max(timeline.date, deadlineContext.inherited ?? Date.distantFuture)
                        DatePicker("Delete on", selection: $customExpiry, in: timeline.date...upper, displayedComponents: [.date, .hourAndMinute])
                            .accessibilityHint("Choose a future time no later than the inherited deadline.")
                        Text("Selected expiration: " + CommentDeadline.absolute(customExpiry)).font(.footnote)
                    }
                    if parentUnavailable { Text("The parent is no longer available. Your draft has not been published.").foregroundStyle(.red) }
                    if let error = deadlineContext.validationMessage(for: timerChoice, now: timeline.date) {
                        Text(error).foregroundStyle(.red).accessibilityIdentifier("composer-expiration-error")
                    }
                    Button(busy ? "Encrypting and sharing…" : post == nil ? (photosOnly ? "Share photos" : "Share post") : "Comment") { Task { await submit() } }
                        .disabled(!model.canWriteSocial || busy || parentUnavailable || deadlineContext.validationMessage(for: timerChoice, now: timeline.date) != nil || (!photosOnly && text.count > 5000) || (photosOnly ? photos.isEmpty : (text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && photos.isEmpty)))
                }
            }
        }
    }.disabled(!model.canWriteSocial || busy).navigationTitle(shareTabs ? "" : post == nil ? "New post" : "Leave a comment").porchInlineTitle().toolbar { Button("Cancel") { dismiss() } }
        .task { await people.load(model); if shareTabs { photosOnly = initialAlbum != nil; album = initialAlbum ?? ""; await model.perform { let service = try NativePhotos(model); var next: String?; var choices: [NativeAlbum] = []; repeat { let result = try await service.request("/albums" + (next.map { "?" + NativePhotos.query(["after": $0]) } ?? "")); for row in result["items"].array where row["role"].string != "read" { let content = try await model.vault.open(row); choices.append(.init(raw: row, name: content["name"].string ?? "Album")) }; next = result["next"].string } while next != nil; try service.check(); albums = choices } } }
        .fileImporter(isPresented: $videoFilePicker, allowedContentTypes: [.movie, UTType(filenameExtension: "webm") ?? .data]) { result in
            Task { await model.perform {
                let url = try result.get()
                let accessed = url.startAccessingSecurityScopedResource(); defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                guard photos.count < 10 else { throw PorchError.message("Choose up to ten attachments.") }
                let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
                let bytes = try handle.read(upToCount: VideoContainer.maximumBytes + 1) ?? Data()
                let generation = model.authenticationGeneration
                let clip = try await VideoPipeline.prepare(bytes)
                guard generation == model.authenticationGeneration, vault.unlocked, !Task.isCancelled else { return }
                photos.append(clip)
            } }
        }
        .onChange(of: timer) { _, value in if value == -1 { customExpiry = deadlineContext.suggestedShorter(now: Date()) } }
        .onChange(of: photoSelection) { _, values in Task { await model.perform { var selected: [PreparedPhoto] = []; for item in values { if let bytes = try await item.loadTransferable(type: Data.self) { if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) { selected.append(try await VideoPipeline.prepare(bytes)) } else { selected.append(try PhotoPipeline.prepare(bytes)) } } }; photos = selected } } }
        #if os(iOS)
        .sheet(isPresented: $camera) { CameraView { image in Task { await model.perform { guard let data = image.jpegData(compressionQuality: 0.9) else { return }; photos.append(try PhotoPipeline.prepare(data)) } }; camera = false } }
        #endif
    }
    private func submit() async { busy = true; defer { busy = false }; await model.perform {
        guard let member = model.member else { return }
        try member.access.requireSocialWrite()
        guard !parentUnavailable else { throw PorchError.message("The parent is no longer available. Your draft has not been published.") }
        if photosOnly {
            let service = try NativePhotos(model), expiry = try deadlineContext.deadline(for: timerChoice, now: Date())
            for var photo in photos where !completedPhotos.contains(photo.id) {
                photo.tags = NativeMentions.resolve(photo.alt + " " + photo.caption, directory: people.people, existing: photo.tags)
                try await service.publish(photo, date: photo.photoDate, audience: audience, album: album.isEmpty ? nil : album, expiry: expiry)
                completedPhotos.insert(photo.id)
            }
            photos = []; photoSelection = []; completedPhotos = []; submitted(); dismiss(); return
        }
        let reviewedParentExpiry = deadlineContext.inherited
        let id = UUID().uuidString.lowercased(), expiry = try deadlineContext.deadline(for: timerChoice, now: Date()), share = post?.context["audience"].string ?? (groupID == nil ? audience : "group"), group = groupID ?? post?.context["groupId"].string
        let generation = model.authenticationGeneration
        @MainActor func checkSession() throws { guard generation == model.authenticationGeneration, model.member?.id == member.id, vault.unlocked, !Task.isCancelled else { throw CancellationError() } }
        var media: [JSON] = []
        for var photo in photos {
            try checkSession()
            photo.tags = NativeMentions.resolve(photo.alt + " " + photo.caption, directory: people.people, existing: photo.tags)
            media.append(try await model.uploadSurfacePhoto(photo, audience: share, parent: id, group: group, expiry: expiry))
        }
        try checkSession()
        var chosenTags = NativeMentions.resolve(text, directory: people.people, existing: tags)
        if !onBehalf.isEmpty {
            guard let child = people.people.first(where: { $0.kind == "child" && $0.personID == onBehalf }) else { throw PorchError.message("Reload the child directory before posting on their behalf.") }
            if !chosenTags.contains(child) { guard chosenTags.count < 30 else { throw PorchError.message("Remove a tag before posting on behalf of a child.") }; chosenTags.append(child) }
        }
        let payload: JSON = .object(["tags": .array(chosenTags.map(\.json)), "text": .string(text.trimmingCharacters(in: .whitespacesAndNewlines)), "reactionSecret": .string(try CryptoVault.randomSecret()), "media": .array(media)])
        let envelope = try await vault.seal(payload, member: member, kind: post == nil ? "post" : "comment", audience: share, id: id, group: group, parent: parent?.id, post: post?.id, expiry: expiry)
        try checkSession()
        if let post {
            do { _ = try await model.api.social("/posts/\(post.id)/comments", method:"POST",body:.object(["envelope":envelope,"parent_expires_at":reviewedParentExpiry.map{.string(PorchDate.string($0))} ?? .null])) }
            catch PorchError.api(let code,_,let details) where code=="PARENT_DEADLINE_CHANGED" {
                guard let changed = details["expires_at"].string.flatMap(PorchDate.parse) else {
                    throw PorchError.message("The parent changed. Close this composer and reopen it to review its deadline. Your draft has not been published.")
                }
                observedExpiry = changed
                // Refresh routing metadata to explain whether the original post or a closer
                // ancestor now limits this reply. Keep the draft and require another submit.
                do {
                    let fresh = try await model.api.social("/posts/" + post.id)
                    observedPostExpiry = CommentDeadline.expiry(of: fresh["post"])
                    if let parent, parent.isComment,
                       !fresh["comments"].array.contains(where: { $0["id"].string == parent.id }) { parentUnavailable = true }
                } catch PorchError.api(let status, _, _) where ["NOT_FOUND", "FORBIDDEN", "ACCOUNT_UNAVAILABLE"].contains(status) {
                    parentUnavailable = true
                } catch { /* The acknowledged server deadline still bounds the retained draft. */ }
                throw PorchError.message("The parent's timer changed. Review the updated inherited timeout above, then submit again.")
            }
        }
        else { _ = try await model.api.social("/posts", method: "POST", body: .object(["envelope": envelope, "media_ids": .array(media.map { $0["id"] }), "on_behalf_of": onBehalf.isEmpty ? .null : .string(onBehalf)])) }
        text = ""; photos = []; photoSelection = []; tags = []; onBehalf = ""
        submitted(); dismiss()
    } }
}
struct InheritedDeadlineNotice: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "timer")
            .font(.callout).fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .ignore).accessibilityLabel(message)
            .accessibilityIdentifier("inherited-expiration-warning")
    }
}
struct EditContentView: View {
    let item: SocialItem; let postID: String; let submitted: () -> Void
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var timer = 0
    @State private var tags: [PersonTag] = []
    @State private var media: [JSON] = []
    @StateObject private var people = PeopleDirectory()
    var body: some View { Form { TextEditor(text: $text).frame(minHeight: 150); PeopleTagPicker(tags: $tags, directory: people);
        ForEach(media.indices, id: \.self) { index in
            TextField("Attachment caption", text: Binding(get: { media[index]["alt"].string ?? "" }, set: { media[index] = media[index].replacing("alt", with: .string($0)) }))
            let originalCaption = (item.payload?["media"].array ?? []).first { $0["id"] == media[index]["id"] }?["caption"].string ?? ""
            if !originalCaption.isEmpty { TextField("Additional caption", text: Binding(get: { media[index]["caption"].string ?? "" }, set: { media[index] = media[index].replacing("caption", with: .string($0)) })) }
            PeopleTagPicker(tags: Binding(get: { PersonTag.parse(media[index]["tags"]) }, set: { media[index] = media[index].replacing("tags", with: .array($0.map(\.json))) }), directory: people)
        }; if let expiry = item.expiry { Text("Current deadline: \(expiry.formatted()). It can only be shortened.") }; Picker("Shorter timeout", selection: $timer) { Text("Keep current timeout").tag(0); Text("One hour from now").tag(3600) }; Button("Save changes") { Task { await model.perform { guard let member = model.member, var payload = item.payload else { return }; let resolved = NativeMentions.resolve(text, directory: people.people, existing: tags)
            let attachments = media.map { photo in photo.replacing("tags", with: .array(NativeMentions.resolve(NativePhotoContract.captions(photo).joined(separator: " "), directory: people.people, existing: PersonTag.parse(photo["tags"])).map(\.json))) }
            payload = payload.replacing("text", with: .string(text)).replacing("tags", with: .array(resolved.map(\.json))).replacing("media", with: .array(attachments)); let context = item.context.replacing("revision", with: .number(Double((item.context["revision"].integer ?? 1) + 1))); let deadline = PorchDate.deadline(seconds: timer, parent: item.expiry); let envelope = try await vault.seal(payload, member: member, kind: item.context["kind"].string ?? "post", audience: item.context["audience"].string ?? "connections", id: item.id, group: item.context["groupId"].string, parent: item.context["parentId"].string, post: postID, expiry: deadline, original: context); let proof = try vault.sign(.object(["purpose": .string("porchday-lifecycle"), "id": .string(item.id), "revision": envelope["context"]["revision"], "expiresAt": envelope["context"]["expiresAt"]])); _ = try await model.api.social("/\(item.isComment ? "comments" : "posts")/\(item.id)", method: "PUT", body: .object(["envelope": envelope, "lifecycle": proof])); submitted(); dismiss() } } }.disabled(text.count > 5000 || !model.canWriteSocial) }.disabled(!model.canWriteSocial).navigationTitle(item.isComment ? "Edit comment" : "Edit post").task { text = item.text; tags = PersonTag.parse(item.payload?["tags"] ?? .null); media = item.payload?["media"].array ?? [] }.toolbar { Button("Cancel") { dismiss() } } }
}

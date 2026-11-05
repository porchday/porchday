import SwiftUI
import AVKit

struct NativeActivity: Identifiable {
    let raw: JSON
    let post: SocialItem?
    var id: String { (raw["kind"].string ?? "") + ":" + (raw["id"].string ?? "") }
    var day: String { raw["day"].string ?? "" }
}
@MainActor final class NativeActivityStore: ObservableObject {
    @Published var rows: [NativeActivity] = []
    @Published var next: JSON = .null
    @Published var busy = false
    @Published var error = ""
    private var attempt = UUID()
    func load(_ model: AppModel, content: String, month: String? = nil, owned: Bool = false, more: Bool = false) async {
        if more && busy { return }
        let token = UUID(); attempt = token; busy = true; error = ""
        if !more { rows = []; next = .null }
        defer { if token == attempt { busy = false } }
        do {
            let service = try NativePhotos(model)
            var fields = ["content": content, "order": month == nil ? "shared" : "date", "timezone": TimeZone.current.identifier]
            if let month { fields["month"] = month }; if owned { fields["owner"] = "me" }
            if more, next != .null { guard let cursor = next.string else { throw PorchError.message("The activity cursor is invalid.") }; fields["after"] = cursor }
            let result = try await service.request("/photo-feed?" + NativePhotos.query(fields))
            var decoded: [NativeActivity] = []
            for raw in result["items"].array {
                var item: SocialItem?
                if raw["kind"].string != "photo" {
                    item = await model.vault.item(raw["post"])
                    if raw["attachment_date"] != .null { try await service.verifyAttachment(raw["attachment_date"], media: raw["id"].string ?? "", post: raw["post"]["id"].string ?? "", owner: raw["author_id"].string ?? "", day: raw["day"].string ?? "") }
                }
                decoded.append(.init(raw: raw, post: item))
            }
            try service.check(); guard token == attempt else { return }
            let existing = more ? rows : []; rows = existing + decoded.filter { row in !existing.contains { $0.id == row.id } }; next = result["next"]
        } catch { if token == attempt && !(error is CancellationError) { self.error = error.localizedDescription } }
    }
}
struct NativeFeedView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var store = NativeActivityStore()
    @State private var content = "everything"
    @State private var from = "connections"
    @State private var calendar = false
    @State private var month = PhotoCalendar.month(Date())
    @State private var selectedDay: String?
    private var monthKey: String? { calendar ? String(PhotoCalendar.day(month).prefix(7)) : nil }
    private var filterKey: String { content + (monthKey ?? "scroll") }
    private var visible: [NativeActivity] { store.rows.filter { NativePhotoContract.matchesAuthor($0.raw, selection: from, member: model.member?.id ?? "") } }
    var body: some View {
        List {
            Picker("View", selection: $calendar) { Text("Infinite scroll").tag(false); Text("Calendar").tag(true) }.pickerStyle(.segmented)
            DisclosureGroup("Filters") {
                Picker("Show", selection: $content) { Text("Everything").tag("everything"); Text("Posts").tag("posts"); Text("Photos").tag("photos") }
                Picker("From", selection: $from) { Text("Only me").tag("me"); Text("Friends").tag("friends"); Text("Family").tag("family"); Text("Friends & Family").tag("connections"); Text("Extended family").tag("extended_family"); Text("Community").tag("community") }
            }
            if calendar {
                Button("Earlier month", systemImage: "arrow.up") { month = PhotoCalendar.calendar.date(byAdding: .month, value: -1, to: month)! }
                Text(month.formatted(.dateTime.month(.wide).year())).font(.headline)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 7)) {
                    ForEach(Array(PhotoCalendar.cells(month).enumerated()), id: \.offset) { _, date in
                        if let date { let day = PhotoCalendar.day(date), count = visible.filter { $0.day == day }.count
                            Button { selectedDay = day } label: { VStack { Text("\(PhotoCalendar.calendar.component(.day, from: date))"); Text(count == 0 ? " " : "\(count)").font(.caption) }.frame(minHeight: 48) }.accessibilityLabel("\(day): \(count) items")
                        } else { Color.clear.frame(height: 48) }
                    }
                }
                Button("Later month", systemImage: "arrow.down") { month = PhotoCalendar.calendar.date(byAdding: .month, value: 1, to: month)! }
            } else {
                ForEach(visible) { NativeActivityCard(entry: $0, changed: { Task { await load() } }) }
            }
            if store.busy { ProgressView("Opening activity…") }
            if !store.error.isEmpty { Text(store.error).foregroundStyle(.red); Button("Retry") { Task { await load() } } }
            if !store.busy && store.error.isEmpty && visible.isEmpty { Text("No matching activity loaded.") }
            if store.next != .null { Button("Load more") { Task { await load(more: true) } }.disabled(store.busy).onAppear { if !calendar { Task { await load(more: true) } } } }
        }.task(id: filterKey) { await load() }.refreshable { await load() }
        .onChange(of: model.historySharingVersion) { _, _ in Task { await load() } }
        .sheet(isPresented: Binding(get: { selectedDay != nil }, set: { if !$0 { selectedDay = nil } })) { NavigationStack { List { ForEach(visible.filter { $0.day == selectedDay }) { NativeActivityCard(entry: $0, changed: { Task { await load() } }) }; if store.next != .null { Button("Load more in this month") { Task { await load(more: true) } }.disabled(store.busy) } }.navigationTitle(selectedDay ?? "Day").toolbar { Button("Done") { selectedDay = nil } } } }
    }
    private func load(more: Bool = false) async { await store.load(model, content: content, month: monthKey, more: more) }
}
struct NativeActivityCard: View {
    let entry: NativeActivity
    var changed: () -> Void = {}
    @EnvironmentObject var model: AppModel
    @State private var editingDate = false
    var body: some View {
        if entry.raw["kind"].string == "photo" { VStack(alignment: .leading) {
            HStack { MemberAvatarView(memberID: entry.raw["author_id"].string ?? "", name: entry.raw["author_handle"].string ?? "Member"); Text("@" + (entry.raw["author_handle"].string ?? "member")).font(.headline) }
            NativePhotoCard(photo: entry.raw["photo"], changed: changed)
        } }
        else if let post = entry.post {
            if entry.raw["kind"].string == "post" { NavigationLink { PostDetailView(id: post.id) } label: { MomentCard(item: post) } }
            else { VStack(alignment: .leading) { Text(post.authorHandle); if let media = post.payload?["media"].array.first(where: { $0["id"] == entry.raw["id"] }) { EncryptedMediaView(media: media) }; Text(entry.day).font(.caption); if post.authorID == model.member?.id && model.canWriteSocial { Button("Change photo date") { editingDate = true }.sheet(isPresented: $editingDate) { NavigationStack { NativeAttachmentDateEditor(media: entry.raw["id"].string!, post: post.id, originalDay: entry.day, saved: changed) } } }; NavigationLink("View post") { PostDetailView(id: post.id) }; if let error = post.error { Text(error).foregroundStyle(.red) } } }
        }
    }
}
struct NativePhotoCard: View {
    let photo: JSON
    var album: JSON? = nil
    var changed: () -> Void = {}
    @EnvironmentObject var model: AppModel
    @State private var image: PlatformImage?
    @State private var content: JSON = .null
    @State private var player: AVPlayer?
    @State private var webM: LocalWebM?
    @State private var file: PrivateMediaFile?
    @State private var error = ""
    @State private var date = Date()
    @State private var alt = ""
    @State private var caption = ""
    @State private var tags: [PersonTag] = []
    @StateObject private var people = PeopleDirectory()
    @State private var editing = false
    @State private var removing: String?
    @State private var removed = false
    @State private var busy = false
    @State private var current: JSON = .null
    private var row: JSON { current == .null ? photo : current }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { clock in
            if removed { Text("Photo removed.") }
            else if row["expires_at"].string.flatMap(PorchDate.parse).map({ $0 <= clock.date }) == true { Text("This photo has expired.") }
            else {
                VStack(alignment: .leading) {
                    if let image { ViewablePhoto(image: image, caption: content["media"].array.first?["alt"].string ?? "", expiresAt: row["expires_at"].string.flatMap(PorchDate.parse)).frame(maxHeight: 420) }
                    else if let player { VideoPlayer(player: player).frame(minHeight: 220) }
                    else if let webM { LocalWebMPlayer(decoder: webM).frame(minHeight: 220) }
                    else if error.isEmpty { ProgressView("Opening photo…") }
                    ForEach(NativePhotoContract.captions(content["media"].array.first ?? .null), id: \.self) { Text($0) }
                    PeopleTagsView(tags: PersonTag.parse(content["media"].array.first?["tags"] ?? .null))
                    Text(row["photo_date"].string ?? "").font(.caption)
                    if content != .null { NativePhotoInteractions(photo: row) }
                    if !error.isEmpty { Text(error).foregroundStyle(.red); Button("Retry photo") { Task { await load() } } }
                    if model.canWriteSocial {
                        if row["owner_id"].string == model.member?.id {
                            Button("Edit photo") { editing = true }
                            Button("Delete photo", role: .destructive) { removing = "delete" }
                        }
                        if let album, row["owner_id"].string == model.member?.id || album["role"].string == "admin" {
                            Button("Remove from album", role: .destructive) { removing = "album" }
                        }
                    }
                }
            }
        }.task(id: photo) { await load() }.task(id: row["expires_at"]) { if let expiry = row["expires_at"].string.flatMap(PorchDate.parse) { try? await Task.sleep(for: .seconds(max(0, expiry.timeIntervalSinceNow))); if !Task.isCancelled { player?.pause(); player = nil; webM?.stop(); webM = nil; file = nil; image = nil; content = .null } } }.onDisappear { player?.pause(); player = nil; webM?.stop(); webM = nil; file = nil; image = nil }
        .confirmationDialog(removing == "delete" ? "Delete this photo and its original post attachment? Saved copies cannot be recalled." : "Remove this album’s access? Other audiences keep access.", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("Confirm", role: .destructive) { let action = removing; removing = nil; Task { busy = true; defer { busy = false }; await model.perform {
                let service = try NativePhotos(model)
                var path = "/photos/" + (row["id"].string ?? "")
                if action == "album" {
                    guard let album, let grant = row["grants"].array.first(where: { $0["album_id"] == album["id"] }), let id = grant["id"].string else { throw PorchError.message("Reload the album before removing this photo.") }
                    path += "/grants/" + id
                }
                _ = try await service.request(path, method: "DELETE"); removed = true; player?.pause(); webM?.stop(); file = nil; image = nil; content = .null; changed()
            } } }
        }
        .sheet(isPresented: $editing) { NavigationStack {
            Form {
                DatePicker("Photo date", selection: $date, displayedComponents: .date)
                TextField("Caption", text: $alt)
                if !(content["media"].array.first?["caption"].string ?? "").isEmpty { TextField("Additional caption", text: $caption) }
                PeopleTagPicker(tags: $tags, directory: people)
                Button("Save photo") { Task { busy = true; defer { busy = false }; await model.perform {
                    let service = try NativePhotos(model)
                    let selected = NativeMentions.resolve(alt + " " + caption, directory: people.people, existing: tags)
                    let metadata: JSON = .object(["alt": .string(alt), "caption": .string(caption), "tags": .array(selected.map(\.json))])
                    try await service.updateDate(row, date: PhotoCalendar.day(date), metadata: metadata)
                    current = try await service.photo(row["id"].string!); editing = false; changed(); await load()
                } } }.disabled(busy || alt.count > 5000 || caption.count > 5000)
            }.navigationTitle("Edit photo").task { await people.load(model) }.toolbar { Button("Cancel") { editing = false }.disabled(busy) }
        } }
    }

    private func load() async {
        do {
            let service = try NativePhotos(model), opened = try await service.read(row); try service.check(); content = opened.content
            let media = content["media"].array[0]
            alt = media["alt"].string ?? ""; caption = media["caption"].string ?? ""; tags = PersonTag.parse(media["tags"])
            let mime = media["mime"].string ?? "image/jpeg"
            if mime.hasPrefix("image/") { image = try PhotoPipeline.safelyDecode(opened.bytes) }
            else if mime == "video/webm" { let decoder = LocalWebM(); _ = try await decoder.open(opened.bytes); try service.check(); webM = decoder }
            else { let prepared = try PrivateMediaFile(opened.bytes, ext: VideoContainer.fileExtension(mime)); file = prepared; player = AVPlayer(url: prepared.url) }
            let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd"; formatter.calendar = PhotoCalendar.calendar; date = formatter.date(from: row["photo_date"].string ?? "") ?? Date(); error = ""
        } catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
    }
}

struct NativeAttachmentDateEditor: View {
    let media: String
    let post: String
    let originalDay: String
    var saved: () -> Void = {}
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var day = ""
    @State private var busy = false
    var body: some View {
        Form {
            TextField("Photo date (YYYY-MM-DD)", text: $day)
            Text("The post date stays unchanged.").font(.caption)
            Button("Save date") { Task { busy = true; defer { busy = false }; await model.perform {
                let service = try NativePhotos(model), date = try NativePhotoContract.date(day), info = try await service.request("/media/" + media + "/photo-date")
                if let id = info["photo_id"].string { let row = try await service.photo(id); try await service.updateDate(row, date: date) }
                else { let proof = try service.attachmentProof(media: media, post: post, date: date, revision: (info["date"]["revision"].integer ?? 0) + 1); _ = try await service.request("/media/" + media + "/photo-date", method: "PUT", body: proof) }
                saved(); dismiss()
            } } }.disabled(busy)
        }.navigationTitle("Photo date").task { day = originalDay }.toolbar { Button("Cancel") { dismiss() }.disabled(busy) }
    }
}

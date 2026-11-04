import SwiftUI

struct NativeAlbum: Identifiable {
    let raw: JSON
    let name: String
    var id: String { raw["id"].string ?? "" }
}
struct NativeAlbumsView: View {
    let upload: (String) -> Void
    @EnvironmentObject var model: AppModel
    @State private var rows: [NativeAlbum] = []
    @State private var next: String?
    @State private var busy = false
    @State private var error = ""
    @State private var name = ""
    @State private var creating = false
    var body: some View {
        List {
            Button("Create album", systemImage: "plus") { creating = true }.disabled(!model.canWriteSocial)
            ForEach(rows) { album in
                NavigationLink { NativeAlbumView(id: album.id, upload: upload) } label: { VStack(alignment: .leading) { Text(album.name).font(.headline); Text("\(album.raw["photo_count"].integer ?? 0) photos · \(albumRoleLabel(album.raw["role"].string ?? "read"))").font(.caption) } }
            }
            if !busy && rows.isEmpty && error.isEmpty { Text("Make an album together. Add people with read-only, add, or album-admin permissions.") }
            if busy { ProgressView() }; if !error.isEmpty { Text(error).foregroundStyle(.red) }
            if next != nil { Button("Load more albums") { Task { await load(more: true) } }.disabled(busy) }
        }.task { await load() }.refreshable { await load() }
        .sheet(isPresented: $creating) { NavigationStack { Form { TextField("Album name", text: $name); Text("You’ll be the album-admin. Add people after creating it."); Button("Create album") { Task { busy = true; defer { busy = false }; await model.perform { let service = try NativePhotos(model); let context = NativePhotoContract.context(kind: "album", id: UUID().uuidString.lowercased(), parent: nil, audience: "only_me", album: nil, expiry: .null); let envelope = try await service.seal(.object(["name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "description": .string("")]), context: context); _ = try await service.request("/albums", method: "POST", body: .object(["envelope": envelope])); creating = false; name = ""; await load() } } }.disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 100) }.navigationTitle("Create album").toolbar { Button("Cancel") { creating = false }.disabled(busy) } } }
    }
    private func load(more: Bool = false) async {
        busy = true; defer { busy = false }
        do { let service = try NativePhotos(model), result = try await service.request("/albums" + (more ? "?" + NativePhotos.query(["after": next ?? ""]) : "")); var decoded: [NativeAlbum] = []
            for row in result["items"].array { let content = try? await model.vault.open(row); decoded.append(.init(raw: row, name: content?["name"].string ?? "Encrypted album — restore its keys")) }
            try service.check(); let old = more ? rows : []; rows = old + decoded.filter { r in !old.contains { $0.id == r.id } }; next = result["next"].string; error = ""
        } catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
    }
}
func albumRoleLabel(_ role: String) -> String { ["read": "Read-only", "add": "Add", "admin": "Album-admin"][role] ?? "Read-only" }
struct NativeAlbumView: View {
    let id: String
    let upload: (String) -> Void
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var data: JSON = .null
    @State private var content: JSON = .null
    @State private var photos: [JSON] = []
    @State private var next: String?
    @State private var busy = false
    @State private var choosing = false
    @State private var notice = ""
    @State private var name = ""
    @State private var connections: [JSON] = []
    @State private var target = ""
    @State private var role = "read"
    @State private var confirmation: String?
    private var admin: Bool { data["album"]["role"].string == "admin" && model.canWriteSocial }
    private var owner: Bool { data["album"]["owner_id"].string == model.member?.id }
    var body: some View {
        List {
            if data != .null {
                Text(content["name"].string ?? "Album").font(.title)
                if !notice.isEmpty { Text(notice).accessibilityAddTraits(.updatesFrequently) }
                if data["album"]["role"].string != "read" && model.canWriteSocial {
                    Button("Upload new photos", systemImage: "plus") { upload(id) }
                    Text("Opens Share → Photos.").font(.caption)
                    Button("Choose existing photos") { choosing = true }
                }
                DisclosureGroup("People & permissions") {
                    Text("Album members can view its photos. A photo’s existing audience keeps access too.")
                    ForEach(Array(data["members"].array.enumerated()), id: \.offset) { _, person in
                        VStack(alignment: .leading) {
                            Text("@" + (person["handle"].string ?? "member"))
                            if admin && person["member_id"] != data["album"]["owner_id"] && person["member_id"].string != model.member?.id {
                                Menu(albumRoleLabel(person["role"].string ?? "read")) {
                                    ForEach(["read", "add", "admin"], id: \.self) { value in Button(albumRoleLabel(value)) { Task { await change(person["member_id"].string!, role: value) } } }
                                    Button("Remove", role: .destructive) { Task { await change(person["member_id"].string!, role: nil) } }
                                }
                            } else { Text(albumRoleLabel(person["role"].string ?? "read")) }
                        }
                    }
                    if admin {
                        Picker("Add a connection", selection: $target) { Text("Choose a person").tag(""); ForEach(Array(connections.enumerated()), id: \.offset) { _, person in let pid = person["id"].string ?? person["member_id"].string ?? ""; if !data["members"].array.contains(where: { $0["member_id"].string == pid }) { Text("@" + (person["handle"].string ?? "member")).tag(pid) } } }
                        Picker("Role", selection: $role) { ForEach(["read", "add", "admin"], id: \.self) { Text(albumRoleLabel($0)).tag($0) } }
                        Button("Add person") { Task { await change(target, role: role) } }.disabled(target.isEmpty)
                        Button("Share existing photos") { Task { await work { try await shareHistory() } } }
                        TextField("Album name", text: $name)
                        Button("Save name") { Task { await work { try await saveMetadata(content.replacing("name", with: .string(name.trimmingCharacters(in: .whitespacesAndNewlines)))); await load() } } }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 100)
                    }
                    if owner && model.canWriteSocial {
                        Button("Delete album", role: .destructive) { confirmation = "delete" }
                        ForEach(Array(data["members"].array.filter { $0["role"].string == "admin" && $0["member_id"].string != model.member?.id }.enumerated()), id: \.offset) { _, person in Button("Transfer ownership to @" + (person["handle"].string ?? "member")) { confirmation = person["member_id"].string } }
                    } else if model.canWriteSocial { Button("Leave album", role: .destructive) { confirmation = "leave" } }
                }
                ForEach(Array(photos.enumerated()), id: \.offset) { _, photo in NativePhotoCard(photo: photo) }
                if next != nil { Button("Load more photos") { Task { await loadPhotos(more: true) } } }
            }
            if busy { ProgressView() }
        }.disabled(busy).task { await load() }.refreshable { await load() }
        .sheet(isPresented: $choosing) { NavigationStack { NativeExistingPhotos(album: id) { count in notice = "\(count) photos added."; choosing = false; Task { await loadPhotos() } } } }
        .confirmationDialog("Confirm album change", isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } })) {
            Button("Confirm", role: .destructive) { let action = confirmation; confirmation = nil; Task { await work { guard let action else { return }; let service = try NativePhotos(model); if action == "delete" { _ = try await service.request("/albums/" + id, method: "DELETE"); dismiss() } else if action == "leave" { _ = try await service.request("/albums/" + id + "/leave", method: "POST", body: .object([:])); dismiss() } else { _ = try await service.request("/albums/" + id + "/transfer", method: "POST", body: .object(["member_id": .string(action)])); await load() } } } }
        } message: { Text("Removing album access does not remove access supplied by other audiences. Ownership transfer gives the new owner control of deletion and transfers.") }
    }
    private func work(_ action: () async throws -> Void) async { guard !busy else { return }; busy = true; defer { busy = false }; await model.perform(action) }
    private func load() async { await model.perform { let service = try NativePhotos(model), result = try await service.request("/albums/" + id), decoded = try await model.vault.open(result["album"]); try service.check(); data = result; content = decoded; name = decoded["name"].string ?? ""; let peers = try await service.request("/connections"); connections = peers["handles"].array; await loadPhotos() } }
    private func loadPhotos(more: Bool = false) async { await model.perform { let service = try NativePhotos(model); var query = ["album": id]; if more, let next { query["after"] = next }; let result = try await service.request("/photos?" + NativePhotos.query(query)); let old = more ? photos : []; photos = old + result["items"].array.filter { p in !old.contains { $0["id"] == p["id"] } }; next = result["next"].string } }
    private func saveMetadata(_ payload: JSON, member: String? = nil, role: String? = nil) async throws {
        let service = try NativePhotos(model), album = data["album"], context = album["envelope"]["context"].replacing("revision", with: .number(Double((album["revision"].integer ?? 0) + 1))).replacing("kind", with: .string("album")).replacing("audience", with: .string("album")).replacing("groupId", with: .string(id)).replacing("parentId", with: .null)
        let suffix = member.map { "?" + NativePhotos.query(["member_id": $0, "role": role ?? "remove"]) } ?? ""
        let envelope = try await service.seal(payload, context: context, snapshot: "/albums/" + id + "/audience" + suffix)
        var body: JSON = .object(["envelope": envelope, "expected_revision": album["revision"]]); if member != nil { body = body.replacing("role", with: role.map(JSON.string) ?? .null) }
        _ = try await service.request("/albums/" + id + (member.map { "/members/" + $0 } ?? ""), method: "PUT", body: body)
    }
    private func change(_ member: String, role: String?) async { await work { let added = role != nil && !data["members"].array.contains { $0["member_id"].string == member }; try await saveMetadata(content, member: member, role: role); target = ""; await load(); if added { try await shareHistory() } } }
    private func shareHistory() async throws {
        let service = try NativePhotos(model); var after: String?, done = 0, failed = 0
        repeat { var query = ["album": id]; if let after { query["after"] = after }; let page = try await service.request("/photos?" + NativePhotos.query(query))
            for photo in page["items"].array { guard let grant = photo["grants"].array.first(where: { $0["album_id"].string == id }) else { continue }; do { try await service.refresh(photo, grant: grant); done += 1 } catch { try service.check(); failed += 1 }; notice = "\(done) photos shared; \(failed) need retry." }
            after = page["next"].string
        } while after != nil
        notice = "\(done) photos shared. \(failed) need retry. Only photos you can decrypt were included."
    }
}
struct NativeExistingPhotos: View {
    let album: String
    let added: (Int) -> Void
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = NativeActivityStore()
    @State private var selected: Set<String> = []
    @State private var completed: Set<String> = []
    @State private var busy = false
    @State private var progress = ""
    @State private var error = ""
    var body: some View {
        List {
            Text("Select from your past uploads, including photos attached to posts. Their existing audiences keep access.")
            if !progress.isEmpty { Text(progress) }; if !error.isEmpty { Text(error).foregroundStyle(.red) }
            ForEach(store.rows) { entry in let included = completed.contains(entry.id) || entry.raw["photo"]["grants"].array.contains { $0["album_id"].string == album }
                VStack { NativeActivityCard(entry: entry); Toggle(included ? "Already in this album" : "Add photo", isOn: Binding(get: { included || selected.contains(entry.id) }, set: { if $0 { selected.insert(entry.id) } else { selected.remove(entry.id) } })).disabled(included || busy) }
            }
            if store.next != .null { Button("Load older photos") { Task { await store.load(model, content: "photos", owned: true, more: true) } }.disabled(busy || store.busy) }
            if !store.error.isEmpty { Text(store.error).foregroundStyle(.red); Button("Retry loading") { Task { await store.load(model, content: "photos", owned: true) } } }
            Button(busy ? "Adding photos…" : "Add \(selected.count) photos") { Task { await save() } }.disabled(selected.isEmpty || busy || !model.canWriteSocial)
        }.navigationTitle("Choose existing photos").toolbar { Button("Done") { if completed.isEmpty { dismiss() } else { added(completed.count) } }.disabled(busy) }.interactiveDismissDisabled(busy)
        .task { await store.load(model, content: "photos", owned: true) }
    }
    private func save() async {
        guard !busy else { return }; busy = true; error = ""; defer { busy = false }
        let rows = store.rows.filter { selected.contains($0.id) }
        do { let service = try NativePhotos(model)
            for (index, entry) in rows.enumerated() { progress = "Adding photo \(index + 1) of \(rows.count)…"; if entry.raw["kind"].string == "photo" { try await service.add(entry.raw["id"].string!, to: album) } else { try await service.adopt(entry.raw, album: album) }; completed.insert(entry.id); selected.remove(entry.id) }
            progress = ""; added(completed.count)
        } catch { progress = "\(completed.count) photos added."; self.error = error.localizedDescription }
    }
}

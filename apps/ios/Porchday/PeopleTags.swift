import SwiftUI

struct PersonTag: Identifiable, Equatable {
    let personID: String
    let kind: String
    let label: String
    var id: String { kind + ":" + personID }
    var json: JSON { .object(["id": .string(personID), "kind": .string(kind), "label": .string(label)]) }
    init?(_ value: JSON) {
        guard let id = value["id"].string, UUID(uuidString: id) != nil,
              let kind = value["kind"].string, ["member", "child"].contains(kind),
              let label = value["label"].string, label.count <= 100 else { return nil }
        personID = id; self.kind = kind; self.label = label
    }
    static func parse(_ value: JSON) -> [PersonTag] { Array(value.array.compactMap(PersonTag.init).prefix(30)) }
    static func content(_ payload: JSON) -> [PersonTag] { parse(payload["tags"]) + payload["media"].array.flatMap { parse($0["tags"]) } }
}
struct ChildProfile: Identifiable {
    let raw: JSON
    let name: String
    let birthday: String
    var id: String { raw["id"].string ?? "" }
}
@MainActor final class PeopleDirectory: ObservableObject {
    @Published var people: [PersonTag] = []
    @Published var children: [ChildProfile] = []
    @Published var error = ""
    @Published var busy = false
    @Published var next: String?
    private var generation = UUID()
    func load(_ model: AppModel, more: Bool = false) async {
        guard !busy, let member = model.member, model.vault.unlocked else { return }
        let attempt = UUID(), auth = model.authenticationGeneration
        generation = attempt; busy = true; error = ""
        defer { if generation == attempt { busy = false } }
        do {
            let connections = try await model.api.social("/connections")
            let path = "/children" + (more ? "?after=" + (next ?? "") : "")
            let result = try await model.api.social(path)
            var records: [ChildProfile] = [], missed = 0
            for row in result["items"].array {
                do {
                    let name = try await model.vault.open(.object(["id": row["id"], "author_id": row["owner_id"], "envelope": row["envelope"]]))
                    guard let label = name["name"].string, !label.isEmpty, label.count <= 100 else { continue }
                    var birthday = ""
                    if row["private_envelope"] != .null {
                        let detail = try await model.vault.open(.object(["id": row["id"], "author_id": row["owner_id"], "envelope": row["private_envelope"]]))
                        birthday = detail["birthday"].string ?? ""
                    }
                    records.append(ChildProfile(raw: row, name: label, birthday: birthday))
                } catch { missed += 1 }
            }
            guard generation == attempt, model.authenticationGeneration == auth, model.member?.id == member.id, model.vault.unlocked, !Task.isCancelled else { return }
            let connected = Set(connections["items"].array.flatMap { [$0["member_a"].string, $0["member_b"].string].compactMap { $0 } })
            var tags = [PersonTag(.object(["id": .string(member.id), "kind": .string("member"), "label": .string(member.handle)]))].compactMap { $0 }
            tags += connections["handles"].array.filter { connected.contains($0["id"].string ?? "") && $0["id"].string != member.id }.compactMap { PersonTag(.object(["id": $0["id"], "kind": .string("member"), "label": $0["handle"]])) }
            children = (more ? children : []) + records.filter { row in !more || !children.contains { $0.id == row.id } }
            tags += children.compactMap { PersonTag(.object(["id": .string($0.id), "kind": .string("child"), "label": .string($0.name)])) }
            people = tags; next = result["next_id"].string
            if missed > 0 { error = "\(missed) child profiles could not be opened. A parent may need to share updated details with this device." }
        } catch { self.error = error.localizedDescription }
    }
}
struct PeopleTagPicker: View {
    @Binding var tags: [PersonTag]
    @ObservedObject var directory: PeopleDirectory
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading) {
            Menu("Tag people") {
                ForEach(directory.people.filter { !tags.contains($0) }) { person in
                    Button((person.kind == "member" ? "@" : "") + person.label) { if tags.count < 30 { tags.append(person) } }
                }
            }.disabled(tags.count >= 30)
            ForEach(tags) { person in Button("Remove \(person.label) ×") { tags.removeAll { $0.id == person.id } } }
            if directory.busy { ProgressView() }
            if !directory.error.isEmpty { Text(directory.error).foregroundStyle(.red); Button("Retry people") { Task { await directory.load(model) } } }
            if directory.next != nil { Button("Load more children") { Task { await directory.load(model, more: true) } } }
            Text("Tags do not change who can read this content.").font(.caption)
        }.task { if directory.people.isEmpty { await directory.load(model) } }
    }
}
struct PeopleTagsView: View {
    let tags: [PersonTag]
    var body: some View {
        ForEach(tags) { tag in
            if tag.kind == "member" { NavigationLink("@" + tag.label) { ProfileView(memberID: tag.personID, handle: tag.label) } }
            else { Label(tag.label, systemImage: "person.crop.circle") }
        }
    }
}
struct ChildrenSettingsView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var directory = PeopleDirectory()
    @State private var editing = false
    @State private var selected: ChildProfile?
    @State private var removing: ChildProfile?
    var body: some View {
        List {
            Text("Children have no login. Names are encrypted for your connections; birthdays are encrypted for your own devices only. Delegates remain the adult authors of their posts.")
            ForEach(directory.children.filter { $0.raw["owner_id"].string == model.member?.id }) { child in
                HStack { Text(child.name); Spacer(); Button("Edit") { selected = child; editing = true }; Button("Remove", role: .destructive) { removing = child } }
            }
            Button("Add child") { selected = nil; editing = true }.disabled(!model.canWriteSocial)
            if !directory.error.isEmpty { Text(directory.error); Button("Retry") { Task { await directory.load(model) } } }
            if directory.next != nil { Button("Load more") { Task { await directory.load(model, more: true) } } }
        }.navigationTitle("Children").task { await directory.load(model) }
        .sheet(isPresented: $editing) { NavigationStack { ChildEditor(child: selected, directory: directory) { Task { await directory.load(model) } } } }
        .confirmationDialog("Remove child and posting permissions? Existing encrypted posts and tags remain with their readers.", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("Remove child", role: .destructive) { guard let child = removing else { return }; Task { await model.perform { _ = try await model.api.social("/children/" + child.id, method: "DELETE"); removing = nil; await directory.load(model) } } }
        }
    }
}
struct ChildEditor: View {
    let child: ChildProfile?
    @ObservedObject var directory: PeopleDirectory
    let saved: () -> Void
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var id = UUID().uuidString.lowercased()
    @State private var name = ""
    @State private var birthday = ""
    @State private var delegates: Set<String> = []
    @State private var busy = false
    var body: some View {
        Form {
            TextField("Child’s name", text: $name)
            TextField("Birthday (YYYY-MM-DD, private to you)", text: $birthday)
            Section("Who else can post on their behalf?") {
                ForEach(directory.people.filter { $0.kind == "member" && $0.personID != model.member?.id }) { person in
                    Toggle("@" + person.label, isOn: Binding(get: { delegates.contains(person.personID) }, set: { if $0 { delegates.insert(person.personID) } else { delegates.remove(person.personID) } }))
                }
            }
            Button(busy ? "Saving…" : "Save child") { Task { await save() } }.disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 100 || !model.canWriteSocial)
        }.padding().navigationTitle(child == nil ? "Add child" : "Edit child").toolbar { Button("Cancel") { dismiss() }.disabled(busy) }
        .task { if let child { id = child.id; name = child.name; birthday = child.birthday; delegates = Set(child.raw["delegates"].array.compactMap(\.string)) } }
    }
    private func save() async {
        busy = true; defer { busy = false }
        await model.perform {
            guard let member = model.member else { return }; try member.access.requireSocialWrite()
            if !birthday.isEmpty {
                let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
                guard let date = formatter.date(from: birthday), formatter.string(from: date) == birthday, date <= Date() else { throw PorchError.message("Enter a valid birthday in the past.") }
            }
            let original: JSON = .object(["id": .string(id), "kind": .string("profile"), "createdAt": .string(PorchDate.string()), "revision": .number(Double((child?.raw["revision"].integer ?? 0) + 1))])
            let envelope = try await model.vault.seal(.object(["name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines))]), member: member, kind: "profile", audience: "connections", id: id, original: original)
            let privateEnvelope = try await model.vault.seal(.object(["birthday": .string(birthday)]), member: member, kind: "profile", audience: "only_me", id: id, original: original)
            _ = try await model.api.social("/children/" + id, method: "PUT", body: .object(["envelope": envelope, "private_envelope": privateEnvelope, "delegates": .array(delegates.sorted().map(JSON.string))]))
            saved(); dismiss()
        }
    }
}

import SwiftUI

struct ConnectionsView: View {
    @EnvironmentObject var model: AppModel
    @State private var data: JSON = .null, handle = "", kind = "friend", searched: JSON?
    var body: some View { List {
        Section { Text("\(data["items"].array.count) of 300 friends, including family").font(.headline); TextField("Find an exact @handle", text: $handle).textInputAutocapitalization(.never).autocorrectionDisabled(); Picker("Connection", selection: $kind) { Text("Friend").tag("friend"); Text("Family").tag("family") }; Button("Send connection request") { Task { await model.perform { _ = try await model.api.social("/connections/requests", method: "POST", body: .object(["handle": .string(handle.lowercased().trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "@", with: "")), "kind": .string(kind)])); handle = ""; await refresh() } } }.disabled(handle.isEmpty); Text("A new connection sees future posts. Historical encrypted content needs an explicit share from its author.").font(.caption).foregroundStyle(.secondary) }
        Section("Pending requests") { ForEach(Array(data["requests"].array.enumerated()), id: \.offset) { _, request in VStack(alignment: .leading) { Text("@" + name(request["sender"].string == model.member?.id ? request["recipient"].string : request["sender"].string)); HStack { if request["recipient"].string == model.member?.id { Button("Accept \(request["kind"].string ?? "friend")") { Task { await action("/connections/requests/\(request["id"].string ?? "")/accept") } } }; Button(request["sender"].string == model.member?.id ? "Cancel" : "Decline", role: .destructive) { Task { await action("/connections/requests/\(request["id"].string ?? "")/decline") } } } } } }
        Section("Your people") { ForEach(Array(data["items"].array.enumerated()), id: \.offset) { _, connection in
            let person = connection["member_a"].string == model.member?.id ? connection["member_b"].string ?? "" : connection["member_a"].string ?? ""
            NavigationLink { ProfileView(memberID: person, handle: name(person)) } label: { Label("@\(name(person)) · \(connection["kind"].string ?? "friend")", systemImage: connection["kind"].string == "family" ? "house" : "person") }
                .swipeActions { Button("Remove", role: .destructive) { Task { await action("/connections/\(connection["id"].string ?? "")", method: "DELETE") } }; Button("Mute") { Task { await action("/mutes/" + person, method: "PUT") } } }
                .contextMenu { Button("Propose family label") { Task { await action("/connections/\(connection["id"].string ?? "")/kind", method: "PUT", body: .object(["kind": .string("family")])) } }; Button("Propose friend label") { Task { await action("/connections/\(connection["id"].string ?? "")/kind", method: "PUT", body: .object(["kind": .string("friend")])) } }; Button("Block", role: .destructive) { Task { await action("/blocks/" + person, method: "PUT") } } }
        } }
    }.navigationTitle("Your people").task { await refresh() }.refreshable { await refresh() } }
    private func name(_ id: String?) -> String { data["handles"].array.first { $0["member_id"].string == id || $0["id"].string == id }?["handle"].string ?? "circle member" }
    private func refresh() async { await model.perform { data = try await model.api.social("/connections") } }
    private func action(_ path: String, method: String = "POST", body: JSON = .object([:])) async { await model.perform { _ = try await model.api.social(path, method: method, body: method == "DELETE" ? nil : body); await refresh() } }
}
struct ProfileView: View {
    let memberID: String; let handle: String
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var profile: JSON = .null, edit = false, compose = false
    var body: some View { VStack(spacing: 0) {
        VStack(alignment: .leading, spacing: 8) { if profile["cover"] != .null { EncryptedPhotoView(photo:profile["cover"]).frame(maxHeight:140).clipped() };if profile["avatar"] != .null { EncryptedPhotoView(photo:profile["avatar"]).frame(width:80,height:80).clipShape(Circle()) };Label(profile["displayName"].string ?? "@" + handle, systemImage: "person.crop.circle").font(.title2.bold()); if let bio = profile["bio"].string { Text(bio) }; if let interests = profile["interests"].string { Text(interests).font(.footnote).foregroundStyle(.secondary) }; if memberID == model.member?.id { HStack { Button("Make this space yours") { edit = true }; Button("Post to my wall") { compose = true } }.font(.callout) } }.frame(maxWidth: .infinity, alignment: .leading).padding().background(profile["theme"].string == "apricot" ? Color.orange.opacity(0.08) : profile["theme"].string == "ink" ? Color.blue.opacity(0.08) : Color.green.opacity(0.08))
        FeedView(title: "@" + handle, endpoint: "/walls/" + memberID)
    }.task { await refresh() }.sheet(isPresented: $edit) { NavigationStack { ProfileEditor(profile: profile) { Task { await refresh() } } } }.sheet(isPresented: $compose) { NavigationStack { ComposerView { } } } }
    private func refresh() async { do { let raw = try await model.api.social("/profiles/" + handle); if raw["envelope"] != .null { profile = try await vault.open(raw) } } catch { profile = .null } }
}
struct GroupsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var groups: [(id: String, name: String)] = [], invitations: [JSON] = [], create = false, name = "", description = ""
    var body: some View { List {
        Section { Text("Private spaces for shared interests. Group membership is separate from your 300 connections.").font(.footnote); Button("Create a named group") { create = true } }
        Section("Your groups") { ForEach(groups, id: \.id) { group in NavigationLink(group.name) { GroupView(id: group.id, title: group.name) } } }
        Section("Invitations") { ForEach(Array(invitations.enumerated()), id: \.offset) { _, invitation in Button("Accept private group invitation") { Task { await model.perform { _ = try await model.api.social("/group-invitations/\(invitation["id"].string ?? "")/accept", method: "POST", body: .object([:])); await refresh() } } } } }
    }.navigationTitle("Groups").task { await refresh() }.refreshable { await refresh() }
        .sheet(isPresented: $create) { NavigationStack { Form { TextField("Group name", text: $name); TextField("Description", text: $description, axis: .vertical); Button("Create private group") { Task { await model.perform { guard let member = model.member else { return }; let envelope = try await vault.seal(.object(["name": .string(name), "description": .string(description)]), member: member, kind: "group", audience: "only_me"); _ = try await model.api.social("/groups", method: "POST", body: .object(["envelope": envelope])); create = false; name = ""; description = ""; await refresh() } } }.disabled(name.isEmpty) }.navigationTitle("Make a space").toolbar { Button("Cancel") { create = false } } } }
    }
    private func refresh() async { await model.perform { let data = try await model.api.social("/groups"); invitations = data["invitations"].array; var rows: [(String,String)] = []; for group in data["items"].array { let payload = try? await vault.open(group); rows.append((group["id"].string ?? "", payload?["name"].string ?? "Private group — awaiting shared keys")) }; groups = rows } }
}
struct GroupView: View {
    let id: String; let title: String
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var manage = false, data: JSON = .null, handle = "", groupPayload: JSON = .null
    var body: some View { FeedView(title: title, endpoint: "/groups/\(id)/posts", showComposer: true, groupID: id)
        .toolbar { Button("Members") { manage = true } }
        .sheet(isPresented: $manage) { NavigationStack { List {
            Section { TextField("Invite an exact @handle", text: $handle).textInputAutocapitalization(.never); Button("Invite") { Task { await run("/groups/\(id)/invitations", body: .object(["handle": .string(handle)])) } }.disabled(handle.isEmpty); Button("Share group details with current members") { Task { await model.perform { guard let member = model.member, groupPayload != .null else { throw PorchError.message("You need access to the group details to share them.") }; let envelope = try await vault.seal(groupPayload, member: member, kind: "group", audience: "group", id: id, group: id, original:data["group"]["envelope"]["context"].replacing("revision",with:.number(Double((data["group"]["envelope"]["context"]["revision"].integer ?? 0)+1))).replacing("createdAt",with:.string(PorchDate.string()))); _ = try await model.api.social("/groups/" + id, method: "PUT", body: .object(["envelope": envelope])); await refresh() } } }; Text("New members receive future posts. Group details and historical posts require an explicit share.").font(.footnote) }
            Section("Members") { ForEach(Array(data["members"].array.enumerated()), id: \.offset) { _, entry in let person = entry["member_id"].string ?? ""; VStack(alignment: .leading) { Text("@\(data["handles"].array.first { $0["member_id"].string == person || $0["id"].string == person }?["handle"].string ?? "member") · \(entry["role"].string ?? "member")"); Menu("Manage membership") { Button("Make moderator") { Task { await run("/groups/\(id)/members/\(person)", method: "PUT", body: .object(["role": .string("moderator")])) } }; Button("Make member") { Task { await run("/groups/\(id)/members/\(person)", method: "PUT", body: .object(["role": .string("member")])) } }; Button("Transfer ownership") { Task { await run("/groups/\(id)/members/\(person)", method: "PUT", body: .object(["role": .string("owner")])) } }; Button("Remove member", role: .destructive) { Task { await run("/groups/\(id)/members/\(person)", method: "DELETE") } } } } } }
            Section { Button("Leave group", role: .destructive) { Task { await run("/groups/\(id)/members/\(model.member?.id ?? "")", method: "DELETE"); manage = false } }; Text("Owners must transfer ownership or delete the group before leaving.").font(.caption); Button("Delete group", role: .destructive) { Task { await run("/groups/" + id, method: "DELETE"); manage = false } } }
        }.navigationTitle("Group members").task { await refresh() }.toolbar { Button("Done") { manage = false } } } } }
    private func refresh() async { await model.perform { data = try await model.api.social("/groups/" + id); groupPayload = (try? await vault.open(data["group"])) ?? .null } }
    private func run(_ path: String, method: String = "POST", body: JSON? = .object([:])) async { await model.perform { _ = try await model.api.social(path, method: method, body: method == "DELETE" ? nil : body); await refresh() } }
}
struct NotificationsView: View {
    @EnvironmentObject var model: AppModel
    @State private var rows: [JSON] = []
    var body: some View { List { if rows.isEmpty { ContentUnavailableView("Nothing new just now", systemImage: "bell") }; ForEach(Array(rows.enumerated()), id: \.offset) { _, row in VStack(alignment: .leading) { if let post = row["post_id"].string { NavigationLink("You have a new update") { PostDetailView(id: post) } } else { Text((row["kind"].string ?? "New update").replacingOccurrences(of: "_", with: " ")) }; if row["read_at"] == .null { Button("Mark read") { Task { await model.perform { _ = try await model.api.social("/notifications/\(row["id"].string ?? "")/read", method: "PUT", body: .object([:])); await refresh() } } }.font(.caption) } } } }.navigationTitle("Notifications").task { await refresh() }.refreshable { await refresh() } }
    private func refresh() async { await model.perform { rows = try await model.api.social("/notifications")["items"].array } }
}
struct ReportView: View {
    let item: SocialItem
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @Environment(\.dismiss) private var dismiss
    @State private var reason = "harassment", description = "", disclose = false
    var body: some View { Form { Section { Text("Moderators cannot browse private posts. This report shares the content reference, author reference, category, and your identity. Select the checkbox only if you want to disclose encrypted evidence.") }; Picker("Concern", selection: $reason) { Text("Harassment").tag("harassment"); Text("AI agent / automated account").tag("agent"); Text("Impersonation").tag("impersonation"); Text("Spam").tag("spam"); Text("Safety").tag("safety"); Text("Other").tag("other") }; if item.payload != nil { Toggle("Disclose this text and my explanation to moderators", isOn: $disclose) }; if disclose { Section("Exact evidence to disclose") { Text(item.text); TextField("Explanation", text: $description, axis: .vertical); Text("Photos and unrelated comments are not included.").font(.caption) } }; Button("Submit report") { Task { await model.perform { guard let member = model.member else { return }; var evidence: JSON = .null; if disclose { evidence = try await vault.seal(.object(["selectedText": .string(item.text), "description": .string(description), "sourceId": .string(item.id), "sourceAuthorId": .string(item.authorID)]), member: member, kind: "report", audience: "moderators", parent: item.id) }; _ = try await model.api.social("/reports", method: "POST", body: .object(["target_member": .string(item.authorID), "target_id": .string(item.id), "reason": .string(reason), "evidence_envelope": evidence, "evidence_disclosed": .bool(disclose)])); dismiss() } } } }.navigationTitle("Report a concern").toolbar { Button("Cancel") { dismiss() } } }
}

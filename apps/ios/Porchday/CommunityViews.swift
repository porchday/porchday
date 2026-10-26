import SwiftUI

struct ConnectionsView: View {
    @EnvironmentObject var model: AppModel
    @State private var data: JSON = .null
    @State private var handle = ""
    @State private var kind = "friend"
    @State private var searched: JSON?
    var body: some View { List {
        Section { Text("\(data["items"].array.count) of 300 friends, including family").font(.headline); TextField("Find an exact @handle", text: $handle).textInputAutocapitalization(.never).autocorrectionDisabled(); Picker("Connection", selection: $kind) { Text("Friend").tag("friend"); Text("Family").tag("family") }; Button("Send connection request") { Task { await model.perform { _ = try await model.api.social("/connections/requests", method: "POST", body: .object(["handle": .string(handle.lowercased().trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "@", with: "")), "kind": .string(kind)])); handle = ""; await refresh() } } }.disabled(handle.isEmpty || !model.canWriteSocial); Text("A new connection sees future posts. Historical encrypted content needs an explicit share from its author.").font(.caption).foregroundStyle(.secondary) }
        PlatformInvitationSection()
        Section("Pending requests") { ForEach(Array(data["requests"].array.enumerated()), id: \.offset) { _, request in VStack(alignment: .leading) { Text("@" + name(request["sender"].string == model.member?.id ? request["recipient"].string : request["sender"].string)); HStack { if request["recipient"].string == model.member?.id { Button("Accept \(request["kind"].string ?? "friend")") { Task { await action("/connections/requests/\(request["id"].string ?? "")/accept") } }.disabled(!model.canWriteSocial) }; Button(request["sender"].string == model.member?.id ? "Cancel" : "Decline", role: .destructive) { Task { await action("/connections/requests/\(request["id"].string ?? "")/decline") } }.disabled(!model.canWriteSocial) } } } }
        Section("Connections") { ForEach(Array(data["items"].array.enumerated()), id: \.offset) { _, connection in
            let person = connection["member_a"].string == model.member?.id ? connection["member_b"].string ?? "" : connection["member_a"].string ?? ""
            NavigationLink { ProfileView(memberID: person, handle: name(person)) } label: { Label("@\(name(person)) · \(connection["kind"].string ?? "friend")", systemImage: connection["kind"].string == "family" ? "house" : "person") }
                .swipeActions { Button("Remove", role: .destructive) { Task { await action("/connections/\(connection["id"].string ?? "")", method: "DELETE") } }.disabled(!model.canWriteSocial); Button("Mute") { Task { await action("/mutes/" + person, method: "PUT") } } }
                .contextMenu { Button("Propose family label") { Task { await action("/connections/\(connection["id"].string ?? "")/kind", method: "PUT", body: .object(["kind": .string("family")])) } }.disabled(!model.canWriteSocial); Button("Propose friend label") { Task { await action("/connections/\(connection["id"].string ?? "")/kind", method: "PUT", body: .object(["kind": .string("friend")])) } }.disabled(!model.canWriteSocial); Button("Block", role: .destructive) { Task { await action("/blocks/" + person, method: "PUT") } } }
        } }
    }.navigationTitle("Connections").task { await refresh() }.refreshable { await refresh() } }
    private func name(_ id: String?) -> String { data["handles"].array.first { $0["member_id"].string == id || $0["id"].string == id }?["handle"].string ?? "member" }
    private func refresh() async { await model.perform { data = try await model.api.social("/connections") } }
    private func action(_ path: String, method: String = "POST", body: JSON = .object([:])) async { await model.perform { _ = try await model.api.social(path, method: method, body: method == "DELETE" ? nil : body); await refresh() } }
}
struct ProfileView: View {
    let memberID: String; let handle: String
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var profile: JSON = .null
    @State private var edit = false
    @State private var compose = false
    @AppStorage("porchday-standard-profile-theme") private var standardTheme = false
    var body: some View {
        FeedView(title: "@" + handle, endpoint: "/walls/" + memberID,
                 profileHeader: AnyView(ProfileHeader(profile: profile, handle: handle, isOwner: memberID == model.member?.id && model.canWriteSocial, standardTheme: $standardTheme,
                                                      edit: { edit = true }, compose: { compose = true })),
                 wallpaper: ProfileWallpaper.displayed(profile["wallpaper"], standardTheme: standardTheme))
            .task(id: model.initialProfileVersion) {
                if memberID == model.member?.id { await model.initializeProfileWallpaper() }
                await refresh()
            }
            .sheet(isPresented: $edit) { NavigationStack { ProfileEditor(profile: profile) { Task { await refresh() } } } }
            .sheet(isPresented: $compose) { NavigationStack { ComposerView { } } }
    }
    private func refresh() async { do { let raw = try await model.api.social("/profiles/" + handle); if raw["envelope"] != .null { profile = try await vault.open(raw) } } catch { profile = .null } }
}
private struct ProfileHeader: View {
    let profile: JSON
    let handle: String
    let isOwner: Bool
    @Binding var standardTheme: Bool
    let edit: () -> Void
    let compose: () -> Void
    private var tint: Color {
        if standardTheme { return .secondary }
        switch profile["theme"].string {
        case "apricot": return .orange
        case "lavender": return .purple
        case "ink": return .blue
        default: return .green
        }
    }
    private var heading: Font { .system(.title2, design: standardTheme || profile["font"].string == "sans" ? .default : .serif, weight: .bold) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if profile["cover"] != .null { EncryptedPhotoView(photo: profile["cover"]).frame(maxHeight: 160).clipped() }
            HStack(alignment: .center) {
                if profile["avatar"] != .null { EncryptedPhotoView(photo: profile["avatar"]).frame(width: 72, height: 72).clipShape(Circle()) }
                VStack(alignment: .leading, spacing: 4) {
                    Text(profile["displayName"].string ?? "@" + handle).font(heading)
                    Text("@" + handle).font(.callout).foregroundStyle(.secondary)
                    if let status = profile["status"].string, !status.isEmpty { Text(status).font(.callout).italic() }
                }
            }
            if !standardTheme && profile["sectionOrder"].string == "interests-first" { interests; about } else { about; interests }
            Toggle("Use standard theme", isOn: $standardTheme).font(.callout)
            Text("This display preference stays on this device and does not change anyone’s profile.").font(.caption).foregroundStyle(.secondary)
            if isOwner {
                HStack { Button("Edit profile", action: edit); Spacer(); Button("Post to my wall", action: compose) }.font(.callout)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            ZStack {
                tint.opacity(0.12)
                if !standardTheme && profile["background"] != .null { EncryptedPhotoView(photo: profile["background"]).opacity(0.12).accessibilityHidden(true) }
            }.clipped()
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
    @ViewBuilder private var about: some View {
        if let text = profile["bio"].string, !text.isEmpty { VStack(alignment: .leading, spacing: 4) { Text("About me").font(.headline); Text(text).textSelection(.enabled) } }
    }
    @ViewBuilder private var interests: some View {
        if let text = profile["interests"].string, !text.isEmpty { VStack(alignment: .leading, spacing: 4) { Text("Interests").font(.headline); Text(text).textSelection(.enabled) } }
    }
}
struct GroupsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var groups: [(id: String, name: String)] = []
    @State private var invitations: [JSON] = []
    @State private var create = false
    @State private var name = ""
    @State private var description = ""
    var body: some View { List {
        Section { Text("Group membership is separate from your 300 connections.").font(.footnote); Button("Create a named group") { create = true }.disabled(!model.canWriteSocial) }
        Section("Your groups") { ForEach(groups, id: \.id) { group in NavigationLink(group.name) { GroupView(id: group.id, title: group.name) } } }
        Section("Invitations") { ForEach(Array(invitations.enumerated()), id: \.offset) { _, invitation in Button("Accept private group invitation") { Task { await model.perform { _ = try await model.api.social("/group-invitations/\(invitation["id"].string ?? "")/accept", method: "POST", body: .object([:])); await refresh() } } }.disabled(!model.canWriteSocial) } }
    }.navigationTitle("Groups").task { await refresh() }.refreshable { await refresh() }
        .sheet(isPresented: $create) { NavigationStack { Form { TextField("Group name", text: $name); TextField("Description", text: $description, axis: .vertical); Button("Create private group") { Task { await model.perform { guard let member = model.member else { return }; let envelope = try await vault.seal(.object(["name": .string(name), "description": .string(description)]), member: member, kind: "group", audience: "only_me"); _ = try await model.api.social("/groups", method: "POST", body: .object(["envelope": envelope])); create = false; name = ""; description = ""; await refresh() } } }.disabled(name.isEmpty || !model.canWriteSocial) }.navigationTitle("Create group").toolbar { Button("Cancel") { create = false } } } }
    }
    private func refresh() async { await model.perform { let data = try await model.api.social("/groups"); invitations = data["invitations"].array; var rows: [(String,String)] = []; for group in data["items"].array { let payload = try? await vault.open(group); rows.append((group["id"].string ?? "", payload?["name"].string ?? "Private group — awaiting shared keys")) }; groups = rows } }
}
struct GroupView: View {
    let id: String; let title: String
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var manage = false
    @State private var data: JSON = .null
    @State private var handle = ""
    @State private var groupPayload: JSON = .null
    @State private var editing = false
    var body: some View { FeedView(title: title, endpoint: "/groups/\(id)/posts", showComposer: true, groupID: id)
        .toolbar { Button("Members") { manage = true } }
        .sheet(isPresented: $manage) { NavigationStack { List {
            Section("About this group") {
                Text(groupPayload["name"].string ?? title).font(.headline)
                if let description = groupPayload["description"].string { Text(description) }
                if groupPayload["image"] != .null { EncryptedPhotoView(photo: groupPayload["image"]).frame(maxHeight: 180) }
                if model.canWriteSocial && data["members"].array.contains(where: { $0["member_id"].string == model.member?.id && ["owner", "moderator"].contains($0["role"].string ?? "") }) {
                    Button("Edit name, description and image") { editing = true }
                }
            }
            Section { TextField("Invite an exact @handle", text: $handle).textInputAutocapitalization(.never); Button("Invite") { Task { await run("/groups/\(id)/invitations", body: .object(["handle": .string(handle)])) } }.disabled(handle.isEmpty || !model.canWriteSocial); Button("Share group details with current members") { Task { await model.perform { guard let member = model.member, groupPayload != .null else { throw PorchError.message("You need access to the group details to share them.") }; var shared = groupPayload;if shared["image"] != .null { shared=shared.replacing("image",with:try await model.reshareSurfacePhoto(shared["image"],audience:"group",parent:id,group:id)) };let envelope = try await vault.seal(shared, member: member, kind: "group", audience: "group", id: id, group: id, original:data["group"]["envelope"]["context"].replacing("revision",with:.number(Double((data["group"]["envelope"]["context"]["revision"].integer ?? 0)+1))).replacing("createdAt",with:.string(PorchDate.string()))); _ = try await model.api.social("/groups/" + id, method: "PUT", body: .object(["envelope": envelope]));if let image=shared["image"]["id"].string { _ = try await model.api.social("/media/"+image+"/attachment",method:"PUT",body:.object(["kind":.string("group"),"target_id":.string(id),"slot":.string("image")])) };await refresh() } } }.disabled(!model.canWriteSocial); Text("New members receive future posts. Group details and historical posts require an explicit share.").font(.footnote) }
            Section("Members") { ForEach(Array(data["members"].array.enumerated()), id: \.offset) { _, entry in let person = entry["member_id"].string ?? ""; VStack(alignment: .leading) { Text("@\(data["handles"].array.first { $0["member_id"].string == person || $0["id"].string == person }?["handle"].string ?? "member") · \(entry["role"].string ?? "member")"); Menu("Manage membership") { Button("Make moderator") { Task { await run("/groups/\(id)/members/\(person)", method: "PUT", body: .object(["role": .string("moderator")])) } }; Button("Make member") { Task { await run("/groups/\(id)/members/\(person)", method: "PUT", body: .object(["role": .string("member")])) } }; Button("Transfer ownership") { Task { await run("/groups/\(id)/members/\(person)", method: "PUT", body: .object(["role": .string("owner")])) } }; Button("Remove member", role: .destructive) { Task { await run("/groups/\(id)/members/\(person)", method: "DELETE") } } }.disabled(!model.canWriteSocial) } } }
            Section { Button("Leave group", role: .destructive) { Task { await run("/groups/\(id)/members/\(model.member?.id ?? "")", method: "DELETE"); manage = false } }.disabled(!model.canWriteSocial); Text("Owners must transfer ownership or delete the group before leaving.").font(.caption); Button("Delete group", role: .destructive) { Task { await run("/groups/" + id, method: "DELETE"); manage = false } } }
        }.navigationTitle("Group members").task { await refresh() }.toolbar { Button("Done") { manage = false } }
            .sheet(isPresented: $editing) { NavigationStack { GroupEditor(id: id, payload: groupPayload, context: data["group"]["envelope"]["context"]) { Task { await refresh() } } } }
        } } }

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
    @State private var reason = "harassment"
    @State private var description = ""
    @State private var disclose = false
    var body: some View { Form { Section { Text("Moderators cannot browse private posts. This report shares the content reference, author reference, category, and your identity. Select the checkbox only if you want to disclose encrypted evidence.") }; Picker("Concern", selection: $reason) { Text("Harassment").tag("harassment"); Text("AI agent / automated account").tag("agent"); Text("Impersonation").tag("impersonation"); Text("Spam").tag("spam"); Text("Safety").tag("safety"); Text("Other").tag("other") }; if item.payload != nil && (vault.canDiscloseEvidence || disclose) { Toggle("Disclose this text and my explanation to moderators", isOn: $disclose).disabled(!vault.canDiscloseEvidence && !disclose) }; if !vault.canDiscloseEvidence { Text("You can send this concern without evidence. Your restored keys cannot sign new evidence while all available devices are revoked.").font(.footnote) }; if disclose && vault.canDiscloseEvidence { Section("Exact evidence to disclose") { Text(item.text); TextField("Explanation", text: $description, axis: .vertical); Text("Photos and unrelated comments are not included.").font(.caption) } }; Button("Submit report") { Task { await model.perform { guard let member = model.member else { return }; var evidence: JSON = .null; if disclose { guard vault.canDiscloseEvidence else { throw PorchError.message("This key cannot sign evidence. Unselect disclosure and send the concern without evidence.") }; evidence = try await vault.seal(.object(["selectedText": .string(item.text), "description": .string(description), "sourceId": .string(item.id), "sourceAuthorId": .string(item.authorID)]), member: member, kind: "report", audience: "moderators", parent: item.id) }; _ = try await model.api.social("/reports", method: "POST", body: .object(["target_member": .string(item.authorID), "target_id": .string(item.id), "reason": .string(reason), "evidence_envelope": evidence, "evidence_disclosed": .bool(disclose)])); dismiss() } } } }.navigationTitle("Report a concern").toolbar { Button("Cancel") { dismiss() } } }
}

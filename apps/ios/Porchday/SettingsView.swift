import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var sessions: [JSON] = []
    @State private var grants: [JSON] = []
    @State private var blocks: [JSON] = []
    @State private var mutes: [JSON] = []
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var confirm = ""
    @State private var archiveKey = ""
    @State private var importKey = ""
    @State private var progress = ""
    @State private var inApp = true
    @State private var pushPreference=false
    @State private var plaintext = false
    @State private var choosing = false
    @State private var sharing = false
    @State private var busy = false
    @State private var deleting = false
    @State private var files: [URL] = []
    @State private var preview: ArchiveSelection?
    var body: some View {
        Form {
            Section("Your private space") { Text("@" + (model.member?.handle ?? "")); if let device = vault.device { Text("Device fingerprint").font(.caption); Text(device.fingerprint).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }; Text("Compare fingerprints through a channel you trust. The service can see account and delivery metadata, but does not hold your content keys.").font(.footnote) }
            Section("Your data belongs to you") {
                Text("Export your own posts, comments, reactions, photos and profile. References to connections and groups are included; other people's private contributions are excluded.")
                Toggle("Export readable, unencrypted ZIP files", isOn: $plaintext)
                if plaintext { Text("Anyone with these files can read them. Saved copies cannot be recalled after deletion or expiry.").foregroundStyle(.orange) }
                Button(busy ? "Preparing archive…" : "Export my data") { Task { await export() } }.disabled(busy)
                if !progress.isEmpty { Text(progress).font(.footnote) }
                if !archiveKey.isEmpty { Text("Save this archive secret separately. It is not your account recovery secret."); Text(archiveKey).font(.system(.body, design: .monospaced)).textSelection(.enabled).privacySensitive() }
                if !files.isEmpty { Button("Save or share archive parts") { sharing = true } }
                SecureField("Archive secret for import", text: $importKey).autocorrectionDisabled()
                Button("Choose all archive parts") { choosing = true }.disabled(busy)
                if let preview { Text("\(preview.entryCount) authored entries · \(preview.photoCount) photos · \(preview.urls.count) parts"); Text("Expired records are skipped. Comments and reactions become private journal entries. Connections and groups are references; importing sends no invitations.").font(.footnote); Button("Import privately") { Task { busy = true; defer { busy = false }; await model.perform { let count = try await model.importOwned(preview); progress = "Imported \(count) entries privately."; self.preview = nil; importKey = "" } } }.disabled(busy) }
            }
            Section("Password and sessions") {
                SecureField("Current password", text: $currentPassword).textContentType(.password)
                SecureField("New password", text: $newPassword).textContentType(.newPassword)
                Button("Change password and sign out other sessions") { Task { await model.perform { _ = try await model.api.auth("change-password", body: .object(["currentPassword":.string(currentPassword),"newPassword":.string(newPassword),"revokeOtherSessions":.bool(true)])); currentPassword = ""; newPassword = ""; await refresh() } } }.disabled(newPassword.count < 12 || currentPassword.isEmpty)
                ForEach(Array(sessions.enumerated()), id: \.offset) { _, session in HStack { VStack(alignment:.leading) { Text(session["userAgent"].string ?? "Signed-in session").lineLimit(2); Text(session["createdAt"].string ?? "").font(.caption) }; Spacer(); Button("Sign out", role:.destructive) { Task { await model.perform { _ = try await model.api.auth("revoke-session", body:.object(["token":session["token"]])); await model.restore(); await refresh() } } } } }
                Button("Sign out other sessions") { Task { await model.perform { _ = try await model.api.auth("revoke-other-sessions", body:.object([:])); await refresh() } } }
                Link("Manage two-factor authentication and email", destination:URL(string:"https://porchday.com/app/settings/security")!)
            }
            Section("Encryption devices") { ForEach(vault.devices) { device in VStack(alignment:.leading) { Text(device.id == vault.device?.id ? "This device" : "Trusted device"); Text(device.fingerprint).font(.system(.caption,design:.monospaced)).textSelection(.enabled); if device.revoked { Text("Revoked").foregroundStyle(.secondary) } else { Button("Revoke this device",role:.destructive) { Task { await model.perform { _ = try await model.api.social("/devices/"+device.id,method:"DELETE"); if device.id == vault.device?.id { await model.signOut() } else { await refresh() } } } } } } }; Text("Revoking a device stops future sharing. It cannot erase content already saved on that device.").font(.footnote) }
            Section("Privacy and notifications") {
                Toggle("In-app updates",isOn:$inApp).onChange(of:inApp) { _,value in Task { await model.perform { _ = try await model.api.social("/me",method:"PATCH",body:.object(["notification_preferences":.object(["in_app":.bool(value),"push":.bool(pushPreference)])])) } } }
                NativeNotificationsSettings()
                NavigationLink("Your notifications") { NotificationsView() }
                ForEach(Array(mutes.enumerated()),id:\.offset) { _, item in Button("Unmute " + (item["target"].string ?? "person")) { Task { await remove("/mutes/",item) } } }
                ForEach(Array(blocks.enumerated()),id:\.offset) { _, item in Button("Unblock " + (item["target"].string ?? "person")) { Task { await remove("/blocks/",item) } } }
                Link("Appeal a moderation decision",destination:URL(string:"https://porchday.com/appeals")!)
                NavigationLink("Report a stolen account") { StolenAccountView() }
            }
            Section("Connected integrations") { Text("Approved tools can read only your own ciphertext. They never receive keys or permission to post as you."); ForEach(Array(grants.enumerated()),id:\.offset) { _,grant in HStack { Text(grant["name"].string ?? "Approved integration"); Spacer(); Button("Revoke",role:.destructive) { Task { await model.perform { _ = try await model.api.social("/integrations/"+(grant["id"].string ?? ""),method:"DELETE"); await refresh() } } } } }; Link("Register or authorize a tool",destination:URL(string:"https://porchday.com/app/settings/data")!) }
            Section("About Porchday") { NavigationLink("Open source notices") { ThirdPartyNoticesView() }; Text("No ads. No influencers. No algorithm. An open source project under Apache 2.0, building toward philanthropy-funded service for the public good."); Link("Privacy and encryption limits",destination:URL(string:"https://porchday.com/privacy")!); Link("Community rules",destination:URL(string:"https://porchday.com/community")!) }
            Section { Button("Sign out and clear this device's keys",role:.destructive) { Task { await model.signOut() } }; Button("Delete my account",role:.destructive) { deleting = true } }
        }.navigationTitle("Your settings").task { await refresh() }
            .fileImporter(isPresented:$choosing,allowedContentTypes:[.data],allowsMultipleSelection:true) { result in Task { await model.perform { let urls = try result.get(); preview = try ArchiveSelection.load(urls:urls,secret:importKey) } } }
            .sheet(isPresented:$sharing) { ShareArchiveFiles(urls:files) }
            .sheet(isPresented:$deleting) { NavigationStack { Form { Text("This permanently removes your profile and contributions and revokes sessions. Transfer or delete groups you own first. Saved exports cannot be recalled. A recent sign-in is required."); TextField("Type DELETE",text:$confirm).textInputAutocapitalization(.characters); Button("Permanently delete my account",role:.destructive) { Task { await model.perform { _ = try await model.api.social("/account",method:"DELETE",body:.object(["confirm":.string("DELETE")])); await model.signOut(); deleting = false } } }.disabled(confirm != "DELETE") }.navigationTitle("Delete your account?").toolbar { Button("Cancel") { deleting = false } } } }
    }
    private func refresh() async { await model.perform { let s = try await model.api.auth("list-sessions",method:"GET"); sessions = s.array; grants = try await model.api.social("/integrations")["grants"].array; if model.member?.raw["status"].string != "suspended" { blocks = try await model.api.social("/blocks")["items"].array; mutes = try await model.api.social("/mutes")["items"].array }; if let member = model.member { try await vault.load(member:member); inApp = member.raw["notification_preferences"]["in_app"].boolean;pushPreference=member.raw["notification_preferences"]["push"].boolean } } }
    private func remove(_ path:String,_ item:JSON) async { await model.perform { _ = try await model.api.social(path+(item["target"].string ?? ""),method:"DELETE"); await refresh() } }
    private func export() async { busy = true; defer { busy = false }; await model.perform { progress = "Preparing encrypted records…"; let result = try await model.exportOwned(plaintext:plaintext) { progress = $0 }; files = result.urls; archiveKey = result.secret ?? ""; progress = "\(files.count) archive parts are ready. Save every part and keep the secret separately." } }
}
struct ShareArchiveFiles: UIViewControllerRepresentable {
    let urls:[URL]
    func makeUIViewController(context:Context)->UIActivityViewController { UIActivityViewController(activityItems:urls,applicationActivities:nil) }
    func updateUIViewController(_ controller:UIActivityViewController,context:Context) {}
}

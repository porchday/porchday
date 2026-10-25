import SwiftUI

@main struct PorchdayApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model).environmentObject(model.vault).tint(Color(red: 0.27, green: 0.39, blue: 0.29))
                .task { await model.restore() }
                .onOpenURL { model.handleURL($0) }
                .onChange(of: scenePhase) { _, phase in if phase == .active, model.member != nil { Task { await model.restore() } } }
                .overlay { if scenePhase != .active { Color(red: 0.97, green: 0.96, blue: 0.92).ignoresSafeArea().overlay(Label("Porchday", systemImage: "sun.max").font(.largeTitle)) } }
        }
    }
}
struct RootView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    var body: some View {
        Group {
            if model.loading { ProgressView("Opening your porch…") }
            else if model.needsTwoFactor { TwoFactorLoginView() }
            else if let member = model.member {
                if vault.unlocked { if member.raw["status"].string == "suspended" { NavigationStack { SettingsView() } } else { MainTabs(member: member) } } else { UnlockView(member: member) }
            } else { LoginView() }
        }
        .alert("Something needs attention", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) { Button("OK") { model.error = nil } } message: { Text(model.error ?? "") }
    }
}
struct MainTabs: View {
    let member: Member
    @EnvironmentObject var model: AppModel
    var body: some View {
        TabView {
            NavigationStack { FeedView(title: "Your porch", endpoint: "/feed", showComposer: true) }.tabItem { Label("Home", systemImage: "house") }
            NavigationStack { ConnectionsView() }.tabItem { Label("Connections", systemImage: "person.2") }
            NavigationStack { GroupsView() }.tabItem { Label("Groups", systemImage: "person.3") }
            NavigationStack { ProfileView(memberID: member.id, handle: member.handle) }.tabItem { Label("My wall", systemImage: "person.crop.rectangle") }
            NavigationStack { SettingsView() }.tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .sheet(isPresented: Binding(get: { model.deepLinkPost != nil }, set: { if !$0 { model.deepLinkPost = nil } })) { if let id = model.deepLinkPost { NavigationStack { PostDetailView(id: id).toolbar { Button("Done") { model.deepLinkPost = nil } } } } }
    }
}
struct LoginView: View {
    @EnvironmentObject var model: AppModel
    @State private var email = ""
    @State private var password = ""
    @State private var handle = ""
    @State private var invitation = ""
    @State private var joining = false
    @State private var adult = false
    @State private var rules = false
    @State private var busy = false
    @State private var info = ""
    @State private var recovery = false
    var body: some View {
        NavigationStack {
            Form {
                Section { VStack(alignment: .leading, spacing: 12) { Image(systemName: "sun.max").font(.largeTitle); Text("Porchday").font(.largeTitle.bold()); Text("a late 90s style social network").font(.title3); Text("No ads. No influencers. No algorithm.").font(.headline); Text("A quieter place for your people. Your private content is end-to-end encrypted.") }.padding(.vertical) }
                Section(joining ? "Join by invitation" : "Welcome back") {
                    TextField("Email address", text: $email).textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Password", text: $password).textContentType(joining ? .newPassword : .password)
                    if joining { TextField("Public handle", text: $handle).textInputAutocapitalization(.never).autocorrectionDisabled(); SecureField("Invitation code", text: $invitation); Toggle("I am at least 18 years old", isOn: $adult); Toggle("I accept the community rules", isOn: $rules); Link("Read the community rules", destination: URL(string: "https://porchday.com/community")!) }
                    Button(busy ? "Please wait…" : joining ? "Create account" : "Log in") { Task { busy = true; defer { busy = false }; await model.perform { if joining { _ = try await model.api.auth("sign-up/email", body: .object(["email": .string(email), "password": .string(password), "handle": .string(handle), "inviteCode": .string(invitation), "adult": .bool(adult), "acceptedRules": .bool(rules)])); info = "Check your email to verify your account, then log in here."; joining = false } else { try await model.signIn(email: email, password: password); password = "" } } } }.disabled(busy || email.isEmpty || password.isEmpty || (joining && (!adult || !rules)))
                    if !info.isEmpty { Text(info).foregroundStyle(.secondary) }
                }
                Section { Button(joining ? "I already have an account" : "I have an invitation") { joining.toggle() }; Button("Forgot password?") { Task { await model.perform { _ = try await model.api.auth("request-password-reset", body: .object(["email": .string(email), "redirectTo": .string("https://porchday.com/reset-password")])); info = "If this account exists, a password reset email is on its way. Encryption recovery is separate." } } }.disabled(email.isEmpty); Button("My account was stolen") { recovery = true } }
                Section { Link("Privacy and encryption limits", destination: URL(string: "https://porchday.com/privacy")!); Text("Invitation-only adult pilot. Human members only; technical proof-of-humanity is future work.").font(.footnote) }
            }.navigationTitle("A little more connection").navigationBarTitleDisplayMode(.inline)
                .sheet(isPresented: $recovery) { NavigationStack { StolenAccountView() } }
        }
    }
}
struct UnlockView: View {
    let member: Member
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var secret = ""
    @State private var saved = false
    @State private var busy = false
    var body: some View {
        NavigationStack { Form {
            Section { Label("Only you hold the key", systemImage: "lock.shield").font(.title2); Text("Your encryption recovery secret is separate from your login password. Support cannot restore encrypted history without it.") }
            if vault.devices.isEmpty {
                if vault.recoveryNote.isEmpty { Section { Button("Create my private keys") { Task { await model.perform { try vault.prepareInitial(member: member) } } } } }
                else { Section("Save this recovery secret somewhere safe") { Text(vault.recoveryNote).font(.system(.body, design: .monospaced)).textSelection(.enabled).privacySensitive(); Text("Save it in a password manager or a private printed note. Do not send it to support."); Toggle("I saved my secret and understand it cannot be replaced", isOn: $saved); Button("My secret is safe. Continue") { Task { busy = true; defer { busy = false }; await model.perform { try await vault.finishInitial(member: member) } } }.disabled(!saved || busy) } }
            } else { Section("Restore and authorize this device") { SecureField("Recovery secret", text: $secret).textContentType(.none).autocorrectionDisabled(); Button("Unlock my porch") { Task { busy = true; defer { busy = false }; await model.perform { try await vault.unlock(member: member, secret: secret.trimmingCharacters(in: .whitespacesAndNewlines)); secret = "" } } }.disabled(secret.isEmpty || busy) } }
            Section { Text("This app stores your device keys in device-only iOS Keychain. Signing out clears local keys. Keep the recovery secret to restore after reinstalling or losing this device.").font(.footnote); Button("Sign out", role: .destructive) { Task { await model.signOut() } } }
        }.navigationTitle("Your private space") }
    }
}
struct StolenAccountView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var account = ""
    @State private var safeEmail = ""
    @State private var sent = false
    var body: some View { Form { Section { Text("Report a stolen account even if you cannot sign in. Use an email address only you can access. Submitting a report does not automatically suspend or grant access to an account.") }; Section { TextField("Account email or handle", text: $account).textInputAutocapitalization(.never); TextField("Safe contact email", text: $safeEmail).keyboardType(.emailAddress).textInputAutocapitalization(.never); Button("Send recovery report") { Task { await model.perform { _ = try await model.api.request("/api/account-recovery/reports", method: "POST", body: .object(["accountReference": .string(account), "safeEmail": .string(safeEmail)])); sent = true } } }.disabled(account.isEmpty || safeEmail.isEmpty); if sent { Text("Check your safe contact email for the next step. Support cannot decrypt your old content.") } } }.navigationTitle("Account stolen?").toolbar { Button("Done") { dismiss() } } }
}

struct TwoFactorLoginView:View {
    @EnvironmentObject var model:AppModel
    @State private var code=""
    @State private var backup=false
    @State private var busy=false
    var body:some View { NavigationStack { Form { Section { Label("One more check",systemImage:"lock.shield");Text("Enter your authenticator code or a single-use backup code.") };Toggle("Use a backup code",isOn:$backup);SecureField(backup ? "Backup code":"Six-digit authenticator code",text:$code).textContentType(.oneTimeCode).keyboardType(backup ? .default:.numberPad);Button("Verify and log in") { Task { busy=true;defer{busy=false};await model.perform { try await model.verifySecondFactor(code:code.trimmingCharacters(in:.whitespacesAndNewlines),backup:backup);code="" } } }.disabled(code.isEmpty || busy);Button("Cancel") { Task { await model.signOut() } } }.navigationTitle("Verify your login") } }
}

import SwiftUI

@main struct PorchdayApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(PorchdayAppDelegate.self) private var appDelegate
    #else
    @NSApplicationDelegateAdaptor(PorchdayAppDelegate.self) private var appDelegate
    #endif
    @StateObject private var model = AppModel()
    @AppStorage("display-color-scheme") private var colorScheme = "system"
    @AppStorage("display-time-zone") private var displayZone = ""
    @Environment(\.scenePhase) private var scenePhase
    init() { PrivateMediaFile.cleanAbandonedFiles() }
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model).environmentObject(model.vault).formStyle(.grouped)
                #if os(macOS)
                .frame(minWidth: 800, minHeight: 650)
                #endif
                .preferredColorScheme(colorScheme == "dark" ? .dark : colorScheme == "light" ? .light : nil)
                .environment(\.timeZone, DisplayPreferences.timeZone(displayZone))
                .tint(Color(red: 0.27, green: 0.39, blue: 0.29))
                .task { model.setSceneActive(scenePhase == .active); await model.restore(); await model.refreshHistoricalPosts() }
                .onOpenURL { model.handleURL($0) }
                #if os(iOS)
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
                    model.vault.clearPresentationCache(); Task { await model.api.invalidateReads() }
                }
                #endif
                .task(id: model.member?.id) { await NativeNotifications.shared.refresh(model: model) }
                .onChange(of: scenePhase) { _, phase in
                    model.setSceneActive(phase == .active)
                    if phase == .active, model.member != nil { Task { await model.refreshForeground() } }
                }
                .overlay { if scenePhase != .active { Color(red: 0.97, green: 0.96, blue: 0.92).ignoresSafeArea().overlay(HStack(spacing: 12) { Image("PorchdayMark").resizable().frame(width: 48, height: 48).accessibilityHidden(true); Text("Porchday").font(.largeTitle) }) } }
        }
    }
}
struct RootView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    var body: some View {
        Group {
            if model.deletionPhase == .accepted { AccountDeletionView() }
            else if model.loading && model.member == nil { ProgressView("Loading…") }
            else if model.needsTwoFactor { TwoFactorLoginView() }
            else if let member = model.member {
                if vault.unlocked || (member.access.restoresKeysLocally && vault.devices.isEmpty) { if !member.access.readsSocial || !vault.unlocked { NavigationStack { SettingsView() } } else { MainTabs(member: member) } } else { UnlockView(member: member) }
            } else { LoginView() }
        }
        .alert("Something needs attention", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) { Button("OK") { model.error = nil } } message: { Text(model.error ?? "") }
    }
}
struct MainTabs: View {
    @ObservedObject private var notifications = NativeNotifications.shared
    let member: Member
    @EnvironmentObject var model: AppModel
    @State private var builderAvailable = false
    @State private var destination: String? = "feed"
    @State private var shareAlbum: String?
    @StateObject private var activity = NativeActivityStore()
    @StateObject private var feedReads = FeedReadState()
    @Environment(\.scenePhase) private var phase
    var body: some View {
        Group {
            #if os(macOS)
            NavigationSplitView {
                List(selection: $destination) {
                    Label("Feed", systemImage: "rectangle.stack").badge(feedReads.count ?? 0).tag("feed")
                    Label("Share", systemImage: "plus.square").tag("share")
                    Label("Albums", systemImage: "rectangle.stack.badge.person.crop").tag("albums")
                    Label("Connections", systemImage: "person.2").tag("connections")
                    Label("More", systemImage: "ellipsis").tag("menu")
                    Label("Groups", systemImage: "person.3").tag("groups")
                    Label("Notifications", systemImage: "bell").tag("notifications")
                    Label("My wall", systemImage: "person.crop.rectangle").tag("wall")
                    if builderAvailable { Label("Feature additions", systemImage: "chevron.left.forwardslash.chevron.right").tag("features") }
                    Label("Settings", systemImage: "gearshape").tag("settings")
                }.navigationTitle("Porchday").navigationSplitViewColumnWidth(min: 180, ideal: 220)
            } detail: { NavigationStack { screen(destination ?? "feed") } }
                .frame(minWidth: 800, minHeight: 600)
            #else
            TabView(selection: $destination) {
                NavigationStack { screen("feed") }.tabItem { Label("Feed", systemImage: "rectangle.stack") }.badge(feedReads.count ?? 0).tag(Optional("feed"))
                NavigationStack { screen("share") }.tabItem { Label("Share", systemImage: "plus.square") }.tag(Optional("share"))
                NavigationStack { screen("albums") }.tabItem { Label("Albums", systemImage: "rectangle.stack.badge.person.crop") }.tag(Optional("albums"))
                NavigationStack { screen("connections") }.tabItem { Label("Connections", systemImage: "person.2") }.tag(Optional("connections"))
                NavigationStack { moreMenu }.tabItem { Label("More", systemImage: "ellipsis") }.tag(Optional("menu"))
            }
            #endif
        }
        .environmentObject(feedReads)
        .environment(\.feedReadActive, destination == "feed")
        .task(id: model.authenticationGeneration) { feedReads.active = phase == .active; await feedReads.run(model) }
        .onChange(of: phase) { _, value in feedReads.active = value == .active; if value == .active { Task { await feedReads.refresh() } } }
        .onAppear { if notifications.showFeed { destination = "feed"; notifications.showFeed = false } }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("PorchdayPushReceived"))) { _ in Task { await feedReads.refresh() } }
        .onChange(of: notifications.showFeed) { _, value in if value { destination = "feed"; notifications.showFeed = false; NotificationCenter.default.post(name: Notification.Name("PorchdayFeedOpened"), object: nil); Task { await feedReads.refresh() } } }
        .task(id: member.id) { builderAvailable = (try? await model.api.social("/builder-chat")) != nil; await model.initializeProfileWallpaper(); await model.refreshHistoricalPosts() }
        .sheet(isPresented: $notifications.showInbox) { NavigationStack { NotificationsView().toolbar { Button("Done") { notifications.showInbox = false } } } }
        .sheet(isPresented: Binding(get: { model.deepLinkPost != nil }, set: { if !$0 { model.deepLinkPost = nil } })) { if let id = model.deepLinkPost { NavigationStack { PostDetailView(id: id).toolbar { Button("Done") { model.deepLinkPost = nil } } } } }
    }
    private var moreMenu: some View {
        List {
            NavigationLink("Groups") { screen("groups") }
            NavigationLink("Notifications") { screen("notifications") }
            NavigationLink("My wall") { screen("wall") }
            if builderAvailable {
                NavigationLink { screen("features") } label: { Label("Feature additions", systemImage: "chevron.left.forwardslash.chevron.right") }
                NavigationLink("Builder chat") { screen("builder") }
            }
            NavigationLink { screen("settings") } label: { Label("Settings", systemImage: "gearshape") }
            Button("Log out") { Task { await model.signOut() } }
        }.navigationTitle("More")
    }
    @ViewBuilder private func screen(_ destination: String) -> some View {
        switch destination {
        case "share": ComposerView(initialAlbum: shareAlbum, shareTabs: true) { shareAlbum = nil; self.destination = "feed" }.id(shareAlbum)
        case "albums": NativeAlbumsView { id in shareAlbum = id; self.destination = "share" }
        case "menu": AnyView(moreMenu)
        case "notifications": NotificationsView()
        case "connections": ConnectionsView()
        case "wall": ProfileView(memberID: member.id, handle: member.handle)
        case "groups": GroupsView()
        case "builder": BuilderChatView()
        case "features": BuilderChatView(features: true)
        case "settings": SettingsView()
        default: NativeFeedView(store: activity)
        }
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
    @State private var invitationReady = false
    @State private var invitationSummary = ""
    @State private var awaitingVerification = false
    @State private var resendAfter = Date.distantPast
    var body: some View {
        NavigationStack {
            Form {
                Section { VStack(alignment: .leading, spacing: 12) { Image("PorchdayMark").resizable().frame(width: 64, height: 64).accessibilityHidden(true); Text("Porchday").font(.largeTitle.bold()); Text("a simple social network").font(.title3); Text("No ads. No influencers. No algorithm.").font(.headline); Text("Your private content is end-to-end encrypted.") }.padding(.vertical) }
                if awaitingVerification {
                    Section("Check your email") {
                        Text("Open the verification email sent to \(email). The link expires in 1 hour. Then return here and log in with the password you chose.")
                        Text("Check your spam folder, too. On your first login, we’ll help you protect your private content and save a recovery secret.")
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Button(context.date < resendAfter ? "Resend available in \(Int(ceil(resendAfter.timeIntervalSince(context.date))))s" : "Resend verification email") {
                                Task { busy = true; defer { busy = false }; await model.perform {
                                    _ = try await model.api.auth("send-verification-email", body: .object(["email": .string(email), "callbackURL": .string(ServerConfiguration.origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/login?verified=1")]))
                                    resendAfter = Date().addingTimeInterval(60)
                                    info = "If this address needs verification, a new link is on its way."
                                } }
                            }.disabled(busy || context.date < resendAfter)
                        }
                        Text("Wrong email? Use the address that received the invitation. Ask your inviter for a new invitation if that address is wrong; invitations cannot be transferred.").font(.footnote)
                        Button("I’ve verified my email — log in") { awaitingVerification = false; info = "" }
                    }
                }
                if !awaitingVerification { Section(joining ? "Create account" : "Log in") {
                    TextField("Email address", text: $email).porchContentType(.emailAddress).porchKeyboard(.emailAddress).porchCapitalization(.never).autocorrectionDisabled()
                    SecureField("Password", text: $password).porchContentType(joining ? .newPassword : .password)
                    if joining { Text("Use the email address that received your invitation. After creating your account, verify your email, then log in to set up private sharing. If the invitation names a Friend or Family connection, verification creates it automatically. The email describes your inviter’s history choice. Your own sharing starts with full history; you can change your sharing choice or label, or disconnect later."); TextField("Public handle", text: $handle).porchCapitalization(.never).autocorrectionDisabled(); if invitationReady {
                            Text("Invitation ready. " + invitationSummary)
                            DisclosureGroup("Use a different invitation code") { SecureField("Invitation code", text: $invitation).onChange(of: invitation) { _, _ in invitationReady = false } }
                        } else {
                            SecureField("Invitation code", text: $invitation)
                            Button("Check invitation") { Task { busy = true; defer { busy = false }; await model.perform {
                                let result = try await model.api.auth("invitation-policy", body: .object(["inviteCode": .string(invitation), "details": .bool(true)]))
                                let kind = result["kind"].string
                                invitationSummary = kind == nil ? "This invitation does not automatically connect you to the inviter." : "Verifying connects you as \(kind == "family" ? "Family" : "Friends"). Your inviter shares \(result["history"].string == "future" ? "only new posts and photos after you connect" : "earlier and future posts and photos for that audience"). Your own sharing starts with full history; you can change it later."
                                invitationReady = true
                            } } }.disabled(busy || invitation.isEmpty)
                        }; Toggle("I am at least 18 years old", isOn: $adult); Toggle("I accept the community rules", isOn: $rules); Link("Read the community rules", destination: ServerConfiguration.origin.appendingPathComponent("community")) }
                    Button(busy ? "Please wait…" : joining ? "Create account" : "Log in") { Task { busy = true; defer { busy = false }; await model.perform { if joining { _ = try await model.api.auth("sign-up/email", body: .object(["email": .string(email), "password": .string(password), "handle": .string(handle), "inviteCode": .string(invitation), "adult": .bool(adult), "acceptedRules": .bool(rules)])); password = ""; info = ""; joining = false; awaitingVerification = true; resendAfter = Date().addingTimeInterval(60) } else { try await model.signIn(email: email, password: password); password = "" } } } }.disabled(busy || email.isEmpty || password.isEmpty || (joining && (!adult || !rules)))
                } }
                if !info.isEmpty { Text(info).foregroundStyle(.secondary) }
                if !awaitingVerification { Section {
                    Button("Resend verification email") { Task { busy = true; defer { busy = false }; await model.perform {
                        _ = try await model.api.auth("send-verification-email", body: .object(["email": .string(email), "callbackURL": .string(ServerConfiguration.origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/login?verified=1")]))
                        awaitingVerification = true; resendAfter = Date().addingTimeInterval(60)
                        info = "If this address needs verification, a new link is on its way."
                    } } }.disabled(busy || email.isEmpty)
                    Button(joining ? "I already have an account" : "I have an invitation") { joining.toggle() }.accessibilityIdentifier("toggle-signup"); Button("Forgot password?") { Task { await model.perform { _ = try await model.api.auth("request-password-reset", body: .object(["email": .string(email), "redirectTo": .string(ServerConfiguration.passwordResetRedirect().absoluteString)])); info = "If this account exists, a password reset email is on its way. Encryption recovery is separate." } } }.disabled(email.isEmpty); Button("My account was stolen") { recovery = true }.accessibilityIdentifier("report-stolen-account") } }
                Section { Link("Privacy and encryption limits", destination: ServerConfiguration.origin.appendingPathComponent("privacy")); Text("Invitation-only adult pilot. Human members only; technical proof-of-humanity is future work.").font(.footnote) }
            }.navigationTitle("Porchday").porchInlineTitle()
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
    @State private var accountControls = false
    @State private var busy = false
    var body: some View {
        NavigationStack { Form {
            Section { Label("Encryption keys", systemImage: "lock.shield").font(.title2); Text("Your encryption recovery secret is separate from your login password. Support cannot restore encrypted history without it.") }
            if vault.devices.isEmpty {
                if vault.recoveryNote.isEmpty { Section { Button("Set up private sharing") { Task { await model.perform { try vault.prepareInitial(member: member) } } } } }
                else { Section("Save this recovery secret somewhere safe") { Text(vault.recoveryNote).font(.system(.body, design: .monospaced)).textSelection(.enabled).privacySensitive(); Text("Save it in a password manager or a private printed note. Do not send it to support."); Toggle("I saved my secret and understand it cannot be replaced", isOn: $saved); Button("Continue") { Task { busy = true; defer { busy = false }; await model.perform { try await vault.finishInitial(member: member) } } }.disabled(!saved || busy) } }
            } else { Section(member.access.restoresKeysLocally ? "Restore your saved keys on this device" : "Restore and authorize this device") { if member.access.restoresKeysLocally { Text("This restores existing keys locally for reading and export. It does not enroll a device or restore social permissions.") }; SecureField("Recovery secret", text: $secret).porchContentType(.none).autocorrectionDisabled(); Button("Unlock") { Task { busy = true; defer { busy = false }; await model.perform { try await vault.unlock(member: member, secret: secret.trimmingCharacters(in: .whitespacesAndNewlines)); secret = "" } } }.disabled(secret.isEmpty || busy) } }
            Section { Button("Account, deletion and appeals without unlocking") { accountControls = true }; Text("This app stores your device keys in device-only Apple Keychain. Signing out clears local keys. Keep the recovery secret to restore after reinstalling or losing this device.").font(.footnote); Button("Sign out", role: .destructive) { Task { await model.signOut() } } }
        }.navigationTitle("Encryption")
            .sheet(isPresented: $accountControls) { NavigationStack { SettingsView(dataOnly: true).toolbar { Button("Done") { accountControls = false } } } }
        }
    }
}
struct StolenAccountView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var account = ""
    @State private var safeEmail = ""
    @State private var sent = false
    var body: some View { Form { Section { Text("Report a stolen account even if you cannot sign in. Use an email address only you can access. Submitting a report does not automatically suspend or grant access to an account.") }; Section { TextField("Account email or handle", text: $account).porchCapitalization(.never); TextField("Safe contact email", text: $safeEmail).porchKeyboard(.emailAddress).porchCapitalization(.never); Button("Send recovery report") { Task { await model.perform { _ = try await model.api.request("/api/account-recovery/reports", method: "POST", body: .object(["accountReference": .string(account), "safeEmail": .string(safeEmail)])); sent = true } } }.disabled(account.isEmpty || safeEmail.isEmpty); if sent { Text("Check your safe contact email for the next step. Support cannot decrypt your old content.") } } }.navigationTitle("Account stolen?").toolbar { Button("Done") { dismiss() } } }
}

struct TwoFactorLoginView:View {
    @EnvironmentObject var model:AppModel
    @State private var code=""
    @State private var backup=false
    @State private var busy=false
    var body:some View { NavigationStack { Form { Section { Label("Two-factor authentication",systemImage:"lock.shield");Text("Enter your authenticator code or a single-use backup code.") };Toggle("Use a backup code",isOn:$backup);SecureField(backup ? "Backup code":"Six-digit authenticator code",text:$code).porchContentType(.oneTimeCode).porchKeyboard(backup ? .default:.numberPad);Button("Verify and log in") { Task { busy=true;defer{busy=false};await model.perform { try await model.verifySecondFactor(code:code.trimmingCharacters(in:.whitespacesAndNewlines),backup:backup);code="" } } }.disabled(code.isEmpty || busy);Button("Cancel") { Task { await model.signOut() } } }.navigationTitle("Verify your login") } }
}

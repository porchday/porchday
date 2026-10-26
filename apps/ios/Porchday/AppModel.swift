import Foundation
import Combine

@MainActor final class AppModel: ObservableObject {
    @Published var member: Member?
    @Published var loading = true
    @Published var needsTwoFactor = false
    @Published var error: String?
    @Published var notice: String?
    @Published var deepLinkPost: String?
    @Published var deletionPhase: AccountDeletionPhase = .idle
    @Published var deletionClearingLocalData = false
    private(set) var authenticationGeneration = 0
    @Published private(set) var initialProfileVersion = 0
    private var profileInitialization: (id: UUID, memberID: String, task: Task<Bool, Never>)?
    let vault = CryptoVault()
    let api = API.shared
    var canWriteSocial: Bool { member?.access.writesSocial == true }
    func restore() async {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-testing") || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil { loading = false; return }
        #endif
        loading = true; defer { loading = false }
        do { let session = try await api.auth("get-session", method: "GET"); guard session["user"]["id"].string != nil else { member = nil; vault.clear(); return }; let member = try Member(try await api.social("/me")); if self.member?.id != member.id { acceptAuthenticatedMember(member) } else { self.member = member }; try await vault.load(member: member) }
        catch { member = nil; vault.clear(); self.error = error.localizedDescription }
    }
    func signIn(email: String, password: String) async throws {
        let result = try await api.auth("sign-in/email", body: .object(["email": .string(email), "password": .string(password)]))
        if result["twoFactorRedirect"].boolean { needsTwoFactor = true; return }
        try await finishSignIn()
    }
    func acceptAuthenticatedMember(_ member: Member) { authenticationGeneration += 1; deletionPhase = .idle; self.member = member; needsTwoFactor = false }
    func finishSignIn() async throws { let member = try Member(try await api.social("/me")); acceptAuthenticatedMember(member); try await vault.load(member: member) }
    func verifySecondFactor(code:String,backup:Bool) async throws { _ = try await api.auth(backup ? "two-factor/verify-backup-code":"two-factor/verify-totp",body:.object(["code":.string(code),"trustDevice":.bool(false)])); try await finishSignIn() }
    func signOut() async {
        authenticationGeneration += 1
        if deletionPhase != .accepted { deletionPhase = .idle }
        profileInitialization?.task.cancel(); profileInitialization = nil
        await NativeNotifications.shared.signOut(model: self)
        _ = try? await api.auth("sign-out", body: .object([:])); await api.clearSession(); vault.clear(); SecureStore.clear(); clearTemporaryArchives(); member = nil; needsTwoFactor = false
    }
    /// A wallpaper is cosmetic: enrollment and access stay successful if this save is unavailable.
    func initializeProfileWallpaper() async {
        guard let member, member.raw["status"].string == "active", vault.unlocked else { return }
        if let pending = profileInitialization, pending.memberID == member.id { _ = await pending.task.value; return }
        profileInitialization?.task.cancel()
        let initializationID = UUID()
        let task = Task { @MainActor [weak self] () -> Bool in
            guard let self else { return false }
            do {
                return try await InitialProfileWallpaper.initialize(read: {
                    try Task.checkCancellation()
                    guard self.member?.id == member.id, self.vault.unlocked else { throw CancellationError() }
                    return try await self.api.social("/me")
                }, create: { payload in
                    try Task.checkCancellation()
                    guard self.member?.id == member.id, self.vault.unlocked else { throw CancellationError() }
                    let original: JSON = .object(["revision": .number(1), "createdAt": .string(PorchDate.string())])
                    let envelope = try await self.vault.seal(payload, member: member, kind: "profile", audience: "connections", id: member.id, original: original)
                    try Task.checkCancellation()
                    guard self.member?.id == member.id, self.vault.unlocked else { throw CancellationError() }
                    _ = try await self.api.social("/profiles/me", method: "PUT", body: .object(["envelope": envelope]))
                })
            } catch { return false } // Retry on a later unlock or wall visit; never clear keys or prevent entry.
        }
        profileInitialization = (initializationID, member.id, task)
        let created = await task.value
        if profileInitialization?.id == initializationID { profileInitialization = nil }
        if created, self.member?.id == member.id { initialProfileVersion += 1 }
    }
    private func clearTemporaryArchives() {
        let root=FileManager.default.temporaryDirectory
        guard let files=try? FileManager.default.contentsOfDirectory(at:root,includingPropertiesForKeys:nil) else{return}
        for url in files where url.lastPathComponent.hasPrefix("porchday-import-") || url.lastPathComponent.hasPrefix("porchday-export-") { try? FileManager.default.removeItem(at:url) }
    }
    func handleURL(_ url: URL) {
        guard url.scheme == "https", url.host == "porchday.com" else { return }
        let path = url.pathComponents; if path.count == 4, path[1] == "app", path[2] == "post", UUID(uuidString: path[3]) != nil { deepLinkPost = path[3] }
    }
    func perform(_ action: () async throws -> Void) async { error = nil; do { try await action() } catch { self.error = error.localizedDescription } }
}

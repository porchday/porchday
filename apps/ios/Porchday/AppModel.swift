import Foundation
import Combine

@MainActor final class AppModel: ObservableObject {
    @Published var member: Member?
    @Published var loading = true
    @Published var needsTwoFactor = false
    @Published var error: String?
    @Published var notice: String?
    @Published var deepLinkPost: String?
    let vault = CryptoVault()
    let api = API.shared
    func restore() async {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-testing") || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil { loading = false; return }
        #endif
        loading = true; defer { loading = false }
        do { let session = try await api.auth("get-session", method: "GET"); guard session["user"]["id"].string != nil else { member = nil; vault.clear(); return }; let member = try Member(try await api.social("/me")); self.member = member; try await vault.load(member: member) }
        catch { member = nil; vault.clear(); self.error = error.localizedDescription }
    }
    func signIn(email: String, password: String) async throws {
        let result = try await api.auth("sign-in/email", body: .object(["email": .string(email), "password": .string(password)]))
        if result["twoFactorRedirect"].boolean { needsTwoFactor = true; return }
        try await finishSignIn()
    }
    func finishSignIn() async throws { let member = try Member(try await api.social("/me")); self.member = member; needsTwoFactor = false; try await vault.load(member: member) }
    func verifySecondFactor(code:String,backup:Bool) async throws { _ = try await api.auth(backup ? "two-factor/verify-backup-code":"two-factor/verify-totp",body:.object(["code":.string(code),"trustDevice":.bool(false)])); try await finishSignIn() }
    func signOut() async {
        _ = try? await api.auth("sign-out", body: .object([:])); await api.clearSession(); vault.clear(); SecureStore.clear(); clearTemporaryArchives(); member = nil; needsTwoFactor = false
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

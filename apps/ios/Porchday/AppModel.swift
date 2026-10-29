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
    private var restoreGeneration = 0
    @Published private(set) var initialProfileVersion = 0
    private var profileInitialization: (id: UUID, memberID: String, task: Task<Bool, Never>)?
    @Published private(set) var historySharingBusy = false
    @Published private(set) var historySharingNotice: String?
    @Published private(set) var historySharingVersion = 0
    private var historySharingNeedsRetry = false
    private var sceneIsActive = false
    private var historySharing: (id: UUID, task: Task<Void, Never>)?
    let vault = CryptoVault()
    let api = API.shared
    var canWriteSocial: Bool { member?.access.writesSocial == true }
    func restore(bootstrapRequest: (@MainActor (String) async throws -> JSON)? = nil) async {
        #if DEBUG
        if bootstrapRequest == nil && (ProcessInfo.processInfo.arguments.contains("--ui-testing") || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil) { loading = false; return }
        #endif
        restoreGeneration += 1
        let attempt = restoreGeneration, generation = authenticationGeneration
        var expectedGeneration = generation
        loading = true; defer { if restoreGeneration == attempt { loading = false } }
        do {
            let bootstrap = try await NativeMemberBootstrap.fetch { path in
                if let bootstrapRequest { return try await bootstrapRequest(path) }
                return try await self.api.social(path)
            }
            guard restoreGeneration == attempt, authenticationGeneration == generation else { return }
            if member?.id != bootstrap.member.id { acceptAuthenticatedMember(bootstrap.member) }
            else { member = bootstrap.member }
            let acceptedGeneration = authenticationGeneration
            expectedGeneration = acceptedGeneration
            try await vault.load(member: bootstrap.member, startupDevices: bootstrap.devices,
                                 isCurrent: { self.restoreGeneration == attempt && self.authenticationGeneration == acceptedGeneration })
        } catch is CancellationError { return }
        catch {
            guard restoreGeneration == attempt, authenticationGeneration == expectedGeneration else { return }
            cancelHistoricalPostSharing(); member = nil; vault.clear()
            self.error = NativeMemberBootstrap.isSignedOut(error) ? nil : error.localizedDescription
        }
    }
    func signIn(email: String, password: String) async throws {
        let result = try await api.auth("sign-in/email", body: .object(["email": .string(email), "password": .string(password)]))
        if result["twoFactorRedirect"].boolean { needsTwoFactor = true; return }
        try await finishSignIn()
    }
    func acceptAuthenticatedMember(_ member: Member) { cancelHistoricalPostSharing(); historySharingNeedsRetry = false; historySharingNotice = nil; authenticationGeneration += 1; deletionPhase = .idle; self.member = member; needsTwoFactor = false }
    func finishSignIn() async throws {
        let generation = authenticationGeneration
        let bootstrap = try await NativeMemberBootstrap.fetch { try await self.api.social($0) }
        guard authenticationGeneration == generation else { throw CancellationError() }
        acceptAuthenticatedMember(bootstrap.member)
        let acceptedGeneration = authenticationGeneration
        try await vault.load(member: bootstrap.member, startupDevices: bootstrap.devices,
                             isCurrent: { self.authenticationGeneration == acceptedGeneration })
    }
    func verifySecondFactor(code:String,backup:Bool) async throws { _ = try await api.auth(backup ? "two-factor/verify-backup-code":"two-factor/verify-totp",body:.object(["code":.string(code),"trustDevice":.bool(false)])); try await finishSignIn() }
    func signOut() async {
        authenticationGeneration += 1
        if deletionPhase != .accepted { deletionPhase = .idle }
        profileInitialization?.task.cancel(); profileInitialization = nil
        cancelHistoricalPostSharing(); historySharingNotice = nil; historySharingNeedsRetry = false
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
    func cancelHistoricalPostSharing() {
        historySharing?.task.cancel(); historySharing = nil; historySharingBusy = false
    }
    func setSceneActive(_ active: Bool) {
        sceneIsActive = active
        if !active { cancelHistoricalPostSharing() }
    }
    /// Sharing policy comes from the server's explicit per-connection choice.
    /// Older connections are not upgraded by opening the app. Bound one pass
    /// to twenty posts and stop mutations when the account or scene changes.
    func refreshHistoricalPosts(retry: Bool = false) async {
        guard sceneIsActive, let member, member.access.writesSocial, vault.unlocked, historySharing == nil,
              retry || !historySharingNeedsRetry else { return }
        let generation = authenticationGeneration, runID = UUID()
        historySharingBusy = true; historySharingNotice = nil; historySharingNeedsRetry = false
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            @MainActor func check() throws {
                try Task.checkCancellation()
                guard self.member?.id == member.id, self.authenticationGeneration == generation,
                      self.member?.access.writesSocial == true, self.vault.unlocked,
                      self.sceneIsActive, self.deletionPhase == .idle else { throw CancellationError() }
            }
            do {
                var cursor: String?, count = 0, pages = 0
                var seen = Set<String>()
                repeat {
                    try check()
                    var query = URLComponents()
                    if let cursor { query.queryItems = [URLQueryItem(name: "cursor", value: cursor)] }
                    let page = try await self.api.social("/posts/audience-refresh" + (query.percentEncodedQuery.map { "?" + $0 } ?? ""))
                    try check()
                    guard case .array(let candidates) = page["items"], candidates.count <= 10,
                          page["next_cursor"] == .null || page["next_cursor"].string != nil else { throw PorchError.message("The history-sharing queue is unavailable.") }
                    pages += 1
                    for row in candidates {
                        guard count < 20 else { break }
                        guard let postID = row["id"].string, UUID(uuidString: postID) != nil,
                              seen.insert(postID).inserted else { throw PorchError.message("The history-sharing queue is unavailable.") }
                        try await HistoricalPostSharing.refresh(postID: postID, memberID: member.id, io: .init(
                            readPost: { try check(); return try await self.api.social("/posts/" + $0) },
                            readAudience: { try check(); return try await self.api.social("/posts/" + $0 + "/audience-refresh/audience") },
                            readPhoto: { id in try check(); let bytes = try await self.api.bytes("/api/v1/media/" + id + "/bytes"); return try JSONDecoder().decode(JSON.self, from: bytes) },
                            open: { try check(); return try await self.vault.open($0) },
                            seal: { payload, context, snapshot in
                                try check()
                                guard let id = context["id"].string, let kind = context["kind"].string, let audience = context["audience"].string else { throw PorchError.message("The encrypted post context is unavailable.") }
                                return try await self.vault.seal(payload, member: member, kind: kind, audience: audience, id: id,
                                    parent: context["parentId"].string, expiry: context["expiresAt"].string.flatMap(PorchDate.parse),
                                    original: context, historySnapshot: snapshot)
                            },
                            sign: { try check(); return try self.vault.sign($0) },
                            reservePhoto: { try check(); return try await self.api.social("/media", method: "POST", body: $0) },
                            uploadPhoto: { path, bytes in try check(); _ = try await self.api.bytes(path, method: "PUT", body: bytes) },
                            publish: { id, body in try check(); return try await self.api.social("/posts/" + id + "/audience-refresh", method: "POST", body: body) },
                            validatePhoto: { payload in
                                guard payload["mime"].string == "image/jpeg", let encoded = payload["bytes"].string,
                                      let bytes = Data(base64Encoded: encoded) else { throw PorchError.message("A photo could not be opened.") }
                                _ = try PhotoPipeline.safelyDecode(bytes)
                            }, check: { try check() }))
                        try check(); count += 1; self.historySharingVersion += 1
                    }
                    cursor = page["next_cursor"].string
                    if cursor != nil && (count >= 20 || pages >= 4) {
                        self.historySharingNotice = "Earlier posts were shared. Continue to check for more."
                        self.historySharingNeedsRetry = true
                        break
                    }
                } while cursor != nil
            } catch is CancellationError { /* Resume from a fresh source on a later foreground. */ }
            catch {
                guard !Task.isCancelled, self.member?.id == member.id, self.authenticationGeneration == generation else { return }
                self.historySharingNotice = "Some earlier posts could not be shared yet. Your account remains available."
                self.historySharingNeedsRetry = true
            }
            if self.historySharing?.id == runID { self.historySharing = nil; self.historySharingBusy = false }
        }
        historySharing = (runID, task)
        await task.value
    }
    private func clearTemporaryArchives() {
        let root=FileManager.default.temporaryDirectory
        guard let files=try? FileManager.default.contentsOfDirectory(at:root,includingPropertiesForKeys:nil) else{return}
        for url in files where url.lastPathComponent.hasPrefix("porchday-import-") || url.lastPathComponent.hasPrefix("porchday-export-") { try? FileManager.default.removeItem(at:url) }
    }
    func handleURL(_ url: URL) {
        guard let postID = ServerConfiguration.postID(from: url) else { return }
        deepLinkPost = postID
    }
    func perform(_ action: () async throws -> Void) async { error = nil; do { try await action() } catch { self.error = error.localizedDescription } }
}

import Foundation

enum AccountDeletionPhase: Equatable { case idle, submitting, accepted, unconfirmed }

enum AccountDeletionResponse {
    static let unconfirmed = "Deletion was not confirmed. The request may have reached the service. Do not submit it again until support has checked its status."
    static func requireAccepted(_ response: JSON) throws {
        guard response == .object(["ok": .bool(true)]) else { throw PorchError.message(unconfirmed) }
    }
    static func isConfirmedRejection(_ error: Error) -> Bool {
        guard case PorchError.api(let code, _, _) = error else { return false }
        return ["RECENT_AUTH_REQUIRED", "OWNED_GROUPS", "ACCOUNT_UNAVAILABLE", "RATE_LIMIT", "ORIGIN_DENIED", "UNAUTHORIZED"].contains(code)
    }
}

extension AppModel {
    func deleteAccount(confirm: String, ownedGroups: [JSON], request: (() async throws -> JSON)? = nil, logout: (() async -> Void)? = nil) async throws {
        guard deletionPhase == .idle, confirm == "DELETE", ownedGroups.isEmpty,
              member?.access.managesData == true else { throw PorchError.message("Review the deletion confirmation and resolve owned groups before continuing.") }
        let requestingMember = member?.id
        let requestingGeneration = authenticationGeneration
        func current() -> Bool { member?.id == requestingMember && authenticationGeneration == requestingGeneration && deletionPhase == .submitting }
        deletionPhase = .submitting
        do {
            let response: JSON
            if let request { response = try await request() }
            else { response = try await api.social("/account", method: "DELETE", body: .object(["confirm": .string("DELETE")])) }
            try AccountDeletionResponse.requireAccepted(response)
        } catch {
            guard current() else { return }
            if AccountDeletionResponse.isConfirmedRejection(error) { deletionPhase = .idle; throw error }
            deletionPhase = .unconfirmed
            throw PorchError.message(AccountDeletionResponse.unconfirmed)
        }
        guard current() else { return }
        deletionPhase = .accepted
        deletionClearingLocalData = true
        if let logout { await logout() } else { await signOut() }
        deletionClearingLocalData = false
    }
}

struct IntegrationGrantSummary {
    let name: String
    let purpose: String
    let scopes: [String]
    let lastUsed: Date?
    let revoked: Bool
    init(_ grant: JSON) {
        name = grant["name"].string ?? "Approved integration"
        purpose = grant["purpose"].string ?? "No purpose provided"
        scopes = grant["scopes"].array.compactMap(\.string)
        lastUsed = grant["last_used_at"].string.flatMap(PorchDate.parse)
        revoked = grant["revoked_at"] != .null
    }
}

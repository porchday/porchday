import Foundation

struct SentPlatformInvitation: Identifiable {
    let id: String
    let email: String
    let requested: Date
    let expires: Date
    let status: String
    let kind: String?
    var statusLabel: String { ["pending": "Pending", "joined": "Joined", "expired": "Expired", "revoked": "Revoked"][status] ?? "Pending" }
    init(_ raw: JSON) throws {
        guard let id = raw["id"].string, UUID(uuidString: id) != nil, let email = raw["email"].string,
              let requested = raw["requested_at"].string.flatMap(PorchDate.parse),
              let expires = raw["expires_at"].string.flatMap(PorchDate.parse),
              let status = raw["status"].string, ["pending", "joined", "expired", "revoked"].contains(status) else {
            throw PorchError.message("Could not load your invitations.")
        }
        self.id = id; self.email = email; self.requested = requested; self.expires = expires; self.status = status; self.kind = raw["kind"].string
    }
}

enum PlatformInvitation {
    static func joinedHandle(_ notice: JSON) -> String? {
        guard notice["kind"].string == "invitation_joined", let handle = notice["actor_handle"].string,
              handle.range(of: #"^[a-z0-9_]{3,24}$"#, options: .regularExpression) != nil else { return nil }
        return handle
    }

    static let acceptedNotice = "Invitation requested. If eligible, they’ll receive an email. Your invitation explains the connection they accept."
    static let unconfirmedNotice = "The invitation request could not be confirmed. Check with the recipient before sending another."

    static func normalizedEmail(_ value: String) throws -> String {
        let email = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard email.count <= 254,
              email.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil else {
            throw PorchError.message("Enter a valid email address.")
        }
        return email
    }

    /// A generic acknowledgement deliberately does not reveal account existence or delivery.
    @MainActor static func send(email: String, member: Member, kind: String = "friend",
        request: (String, JSON) async throws -> JSON
    ) async throws -> String {
        try member.access.requireSocialWrite()
        let email = try normalizedEmail(email)
        guard ["friend", "family"].contains(kind) else { throw PorchError.message("Choose Friend or Family.") }
        do {
            let response = try await request("/platform-invitations", .object(["email": .string(email), "kind": .string(kind)]))
            guard response["accepted"] == .bool(true) else { throw PorchError.message(unconfirmedNotice) }
            return acceptedNotice
        } catch let PorchError.api(code, _, _) {
            let message: String
            switch code {
            case "INVALID_EMAIL": message = "Enter a valid email address."
            case "ACCOUNT_UNAVAILABLE": message = "Invitations are available only to active accounts."
            case "PILOT_CLOSED": message = "New registrations are currently closed."
            case "INVITATION_LIMIT": message = "Invitation limit reached. Try again later."
            case "INVITATIONS_PAUSED": message = "Invitations are temporarily paused."
            case "UNAUTHORIZED": message = "Sign in again to send an invitation."
            default: message = unconfirmedNotice
            }
            throw PorchError.message(message)
        } catch {
            throw PorchError.message(unconfirmedNotice)
        }
    }
}

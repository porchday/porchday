import Foundation

enum PlatformInvitation {
    static let acceptedNotice = "Invitation requested. If eligible, they’ll receive an email. You can connect once they join."
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
    @MainActor static func send(email: String, member: Member,
        request: (String, JSON) async throws -> JSON
    ) async throws -> String {
        try member.access.requireSocialWrite()
        let email = try normalizedEmail(email)
        do {
            let response = try await request("/platform-invitations", .object(["email": .string(email)]))
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

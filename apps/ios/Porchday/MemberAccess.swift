import Foundation

/// Client presentation rules; the API still authorizes every request independently.
struct MemberAccess: Equatable, Sendable {
    let status: String
    var writesSocial: Bool { status == "active" }
    var readsSocial: Bool { writesSocial || status == "restricted" }
    var managesData: Bool { readsSocial || status == "suspended" }
    var restoresKeysLocally: Bool { status == "restricted" || status == "suspended" }
    var notice: String? {
        switch status {
        case "restricted": "Social changes are restricted. You can still read shared content, report concerns, appeal, export your data or delete your account."
        case "suspended": "Social access is suspended. Your own data export, account deletion and independent appeals remain available."
        default: nil
        }
    }
    func permitsSealing(kind: String) -> Bool { writesSocial || (status == "restricted" && kind == "report") }
    func requireSocialWrite() throws {
        guard writesSocial else { throw PorchError.message("Social changes are unavailable. Your data and appeals remain available.") }
    }
}

extension Member {
    var access: MemberAccess { MemberAccess(status: raw["status"].string ?? "unavailable") }
}

struct NativeSettingsSnapshot: Sendable {
    let sessions: [JSON]
    let grants: [JSON]
    let blocks: [JSON]
    let mutes: [JSON]
    let ownedGroups: [JSON]

    @MainActor static func load(member: Member, dataOnly: Bool = false,
        auth: (String) async throws -> JSON,
        social: (String) async throws -> JSON
    ) async throws -> NativeSettingsSnapshot {
        guard member.access.managesData else { throw PorchError.message("Account data is unavailable while ownership is under review.") }
        let sessions = try await auth("list-sessions").array
        let ownedGroups = try await social("/owned-groups")["items"].array
        // Suspended sessions may access their own data, never general social routes.
        if dataOnly || !member.access.readsSocial {
            return .init(sessions: sessions, grants: [], blocks: [], mutes: [], ownedGroups: ownedGroups)
        }
        let grants = try await social("/integrations")["grants"].array
        let blocks = try await social("/blocks")["items"].array
        let mutes = try await social("/mutes")["items"].array
        return .init(sessions: sessions, grants: grants, blocks: blocks, mutes: mutes, ownedGroups: ownedGroups)
    }

    @MainActor static func deleteOwnedGroup(_ id: String, reviewedGroups: [JSON], member: Member,
        remove: (String) async throws -> Void
    ) async throws {
        guard member.access.managesData, UUID(uuidString: id) != nil,
              reviewedGroups.contains(where: { $0["id"].string == id }) else {
            throw PorchError.message("Review the current groups you own before deleting one.")
        }
        try await remove("/groups/" + id)
    }
}

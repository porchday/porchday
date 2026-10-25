import Foundation
import XCTest
@testable import Porchday

final class MemberAccessTests: XCTestCase {
    private func member(_ status: String) throws -> Member {
        try Member(.object(["id": .string("synthetic-member"), "handle": .string("synthetic"), "status": .string(status)]))
    }

    func testRestrictionsKeepDataAndSafetyButNeverSocialPublishing() throws {
        let active = try member("active").access
        XCTAssertTrue(active.writesSocial); XCTAssertFalse(active.restoresKeysLocally)
        for status in ["restricted", "suspended"] {
            let access = try member(status).access
            XCTAssertTrue(access.managesData); XCTAssertTrue(access.restoresKeysLocally)
            XCTAssertFalse(access.writesSocial); XCTAssertThrowsError(try access.requireSocialWrite())
            for kind in ["post", "comment", "reaction", "profile", "group", "media"] { XCTAssertFalse(access.permitsSealing(kind: kind)) }
        }
        XCTAssertTrue(try member("restricted").access.readsSocial)
        XCTAssertTrue(try member("restricted").access.permitsSealing(kind: "report"))
        XCTAssertFalse(try member("suspended").access.readsSocial)
        XCTAssertFalse(try member("suspended").access.permitsSealing(kind: "report"))
        for status in ["hold", "deleted", "deleting", "unrecognized", ""] {
            let access = try member(status).access
            XCTAssertFalse(access.managesData); XCTAssertFalse(access.writesSocial); XCTAssertFalse(access.permitsSealing(kind: "report"))
        }
    }

    @MainActor func testSuspendedSettingsNeverRequestForbiddenSocialEndpoints() async throws {
        var requests: [String] = []
        let group: JSON = .object(["id": .string(UUID().uuidString.lowercased())])
        let snapshot = try await NativeSettingsSnapshot.load(member: member("suspended"), auth: { path in
            requests.append("auth:" + path); return .array([.object(["id": .string("synthetic-session")])])
        }, social: { path in
            requests.append(path)
            guard path == "/owned-groups" else { throw PorchError.message("Forbidden test endpoint") }
            return .object(["items": .array([group])])
        })
        XCTAssertEqual(requests, ["auth:list-sessions", "/owned-groups"])
        XCTAssertEqual(snapshot.ownedGroups, [group]); XCTAssertEqual(snapshot.sessions.count, 1)
        XCTAssertTrue(snapshot.grants.isEmpty && snapshot.blocks.isEmpty && snapshot.mutes.isEmpty)
    }

    @MainActor func testLockedAccountControlsUseOnlyOwnMetadataForEverySupportedStatus() async throws {
        for status in ["active", "restricted", "suspended"] {
            var paths: [String] = []
            _ = try await NativeSettingsSnapshot.load(member: member(status), dataOnly: true,
                auth: { paths.append("auth:" + $0); return .array([]) },
                social: { paths.append($0); return .object(["items": .array([])]) })
            XCTAssertEqual(paths, ["auth:list-sessions", "/owned-groups"], status)
        }
    }

    @MainActor func testRestrictedSettingsPreserveSafetyAndIntegrationRevocationMetadata() async throws {
        var paths: [String] = []
        let snapshot = try await NativeSettingsSnapshot.load(member: member("restricted"),
            auth: { paths.append($0); return .array([]) },
            social: { paths.append($0); return .object(["items": .array([.string("synthetic-item")]), "grants": .array([.string("synthetic-grant")])]) })
        XCTAssertEqual(paths, ["list-sessions", "/owned-groups", "/integrations", "/blocks", "/mutes"])
        XCTAssertEqual(snapshot.grants, [.string("synthetic-grant")]); XCTAssertEqual(snapshot.blocks.count, 1)
    }

    @MainActor func testHoldCannotReadSettingsOrDeleteOwnedGroups() async throws {
        var calls = 0
        do {
            _ = try await NativeSettingsSnapshot.load(member: member("hold"), auth: { _ in calls += 1; return .null }, social: { _ in calls += 1; return .null })
            XCTFail("A hold must not reach data endpoints")
        } catch { XCTAssertEqual(calls, 0) }
        let id = UUID().uuidString.lowercased()
        do {
            try await NativeSettingsSnapshot.deleteOwnedGroup(id, reviewedGroups: [.object(["id": .string(id)])], member: member("hold")) { _ in calls += 1 }
            XCTFail("A hold must not delete a group")
        } catch { XCTAssertEqual(calls, 0) }
    }

    @MainActor func testOwnedGroupDeletionUsesOnlyTheReviewedIDAndDoesNotRetryFailure() async throws {
        let id = UUID().uuidString.lowercased(), other = UUID().uuidString.lowercased()
        let groups: [JSON] = [.object(["id": .string(id)])]
        var paths: [String] = []
        try await NativeSettingsSnapshot.deleteOwnedGroup(id, reviewedGroups: groups, member: member("suspended")) { paths.append($0) }
        XCTAssertEqual(paths, ["/groups/" + id])
        for invalid in [other, "../../account", ""] {
            do {
                try await NativeSettingsSnapshot.deleteOwnedGroup(invalid, reviewedGroups: groups, member: member("restricted")) { paths.append($0) }
                XCTFail("Unreviewed group must be rejected")
            } catch { XCTAssertEqual(paths.count, 1) }
        }
        do {
            try await NativeSettingsSnapshot.deleteOwnedGroup(id, reviewedGroups: groups, member: member("suspended")) { path in
                paths.append(path); throw PorchError.message("Synthetic uncertain response")
            }
            XCTFail("Deletion uncertainty must remain visible")
        } catch { XCTAssertEqual(paths.count, 2) }
    }

    func testPasswordResetReturnsToTheImplementedPageOnTheSelectedOrigin() {
        for host in ["porchday.com", "staging.porchday.com"] {
            let origin = URL(string: "https://" + host)!
            let callback = ServerConfiguration.passwordResetRedirect(origin: origin)
            XCTAssertEqual(callback.absoluteString, "https://" + host + "/reset")
            XCTAssertTrue(ServerConfiguration.permits(callback, origin: origin))
            XCTAssertNil(callback.query); XCTAssertNil(callback.fragment)
        }
    }
}

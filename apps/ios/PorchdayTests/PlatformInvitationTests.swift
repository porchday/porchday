import XCTest
@testable import Porchday

final class PlatformInvitationTests: XCTestCase {
    private func member(_ status: String = "active") throws -> Member {
        try Member(.object(["id": .string("synthetic-member"), "handle": .string("synthetic"), "status": .string(status)]))
    }

    @MainActor func testAcceptedInvitationSendsEmailAndConnectionLabel() async throws {
        var requests: [(String, JSON)] = []
        let notice = try await PlatformInvitation.send(email: "  Person+invite@Example.Test \n", member: member()) { path, body in
            requests.append((path, body))
            return .object(["accepted": .bool(true), "message": .string("Ignored provider text")])
        }
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.0, "/platform-invitations")
        XCTAssertEqual(requests.first?.1, .object(["email": .string("person+invite@example.test"), "kind": .string("friend")]))
        XCTAssertEqual(notice, PlatformInvitation.acceptedNotice)
        XCTAssertFalse(notice.contains("delivered"))
    }

    @MainActor func testRestrictedAccountsAndInvalidEmailsNeverReachTransport() async throws {
        var calls = 0
        for status in ["restricted", "suspended", "hold", "deleting", "deleted", "unknown"] {
            do {
                _ = try await PlatformInvitation.send(email: "person@example.test", member: member(status)) { _, _ in calls += 1; return .null }
                XCTFail("Only active accounts may invite")
            } catch { XCTAssertEqual(calls, 0) }
        }
        for email in ["", "person", "person@", "person @example.test", "person@example.test\nBcc: other@example.test", String(repeating: "a", count: 255) + "@example.test"] {
            do {
                _ = try await PlatformInvitation.send(email: email, member: member()) { _, _ in calls += 1; return .null }
                XCTFail("Invalid input must not be sent")
            } catch { XCTAssertEqual(calls, 0) }
        }
    }

    @MainActor func testMalformedAcknowledgementsAndTransportFailureRemainUnconfirmedWithoutRetry() async throws {
        for response: JSON in [.null, .object([:]), .object(["accepted": .string("true")]), .object(["accepted": .bool(false)])] {
            var calls = 0
            do {
                _ = try await PlatformInvitation.send(email: "person@example.test", member: member()) { _, _ in calls += 1; return response }
                XCTFail("A malformed acknowledgement cannot claim acceptance")
            } catch {
                XCTAssertEqual(calls, 1)
                XCTAssertEqual(error.localizedDescription, PlatformInvitation.unconfirmedNotice)
            }
        }
        var calls = 0
        do {
            _ = try await PlatformInvitation.send(email: "person@example.test", member: member()) { _, _ in
                calls += 1; throw URLError(.timedOut)
            }
            XCTFail("A timeout must not retry an email request")
        } catch { XCTAssertEqual(calls, 1); XCTAssertEqual(error.localizedDescription, PlatformInvitation.unconfirmedNotice) }
    }

    @MainActor func testAdmissionQuotaAndPausedErrorsGiveFixedGuidance() async throws {
        for code in ["PILOT_CLOSED", "ACCOUNT_UNAVAILABLE", "INVITATION_LIMIT", "INVITATIONS_PAUSED", "INVALID_EMAIL", "UNAUTHORIZED"] {
            var calls = 0
            do {
                _ = try await PlatformInvitation.send(email: "person@example.test", member: member()) { _, _ in
                    calls += 1; throw PorchError.api(code: code, message: "Sensitive upstream diagnostic", details: .null)
                }
                XCTFail("A rejected request must not claim acceptance")
            } catch {
                XCTAssertEqual(calls, 1)
                XCTAssertFalse(error.localizedDescription.contains("Sensitive"))
                XCTAssertNotEqual(error.localizedDescription, PlatformInvitation.acceptedNotice)
            }
        }
    }
    func testJoinedInvitationIdentifiesOnlyAValidHandle() {
        let notice: JSON = .object(["kind": .string("invitation_joined"), "actor_handle": .string("new_member")])
        XCTAssertEqual(PlatformInvitation.joinedHandle(notice), "new_member")
        XCTAssertNil(PlatformInvitation.joinedHandle(notice.replacing("kind", with: .string("comment"))))
        XCTAssertNil(PlatformInvitation.joinedHandle(notice.replacing("actor_handle", with: .string("../settings"))))
        XCTAssertNil(PlatformInvitation.joinedHandle(.object(["kind": .string("invitation_joined")])))
    }

    func testSentInvitationStatusesAndDates() throws {
        for (status, label) in [("pending", "Pending"), ("joined", "Joined"), ("expired", "Expired"), ("revoked", "Revoked")] {
            let raw: JSON = .object(["id": .string(UUID().uuidString), "email": .string("person@example.test"),
                "requested_at": .string("2026-10-27T00:00:00Z"), "expires_at": .string("2026-11-03T00:00:00Z"), "status": .string(status)])
            let invitation = try SentPlatformInvitation(raw)
            XCTAssertEqual(invitation.statusLabel, label)
            XCTAssertEqual(invitation.email, "person@example.test")
            XCTAssertGreaterThan(invitation.expires, invitation.requested)
            XCTAssertThrowsError(try SentPlatformInvitation(raw.replacing("status", with: .string("account_exists"))))
            XCTAssertThrowsError(try SentPlatformInvitation(raw.replacing("requested_at", with: .string("invalid"))))
        }
    }

}

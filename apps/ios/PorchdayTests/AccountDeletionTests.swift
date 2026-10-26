import Foundation
import XCTest
@testable import Porchday

final class AccountDeletionTests: XCTestCase {
    @MainActor private func model(_ status: String = "active") throws -> AppModel {
        let model = AppModel()
        model.member = try Member(.object(["id": .string("synthetic-deletion"), "handle": .string("synthetic"), "status": .string(status)]))
        return model
    }
    @MainActor func testUnknownResponsesPreserveAccountAndPreventDuplicateRequest() async throws {
        for response: JSON in [.null, .object([:]), .object(["ok": .bool(false)]), .object(["ok": .string("true")]), .object(["ok": .bool(true), "pending": .bool(true)])] {
            let model = try model(); var requests = 0; var logouts = 0
            do {
                try await model.deleteAccount(confirm: "DELETE", ownedGroups: [], request: { requests += 1; return response }, logout: { logouts += 1 })
                XCTFail("Only exact confirmation can clear account access")
            } catch { XCTAssertEqual(error.localizedDescription, AccountDeletionResponse.unconfirmed) }
            XCTAssertEqual(model.deletionPhase, .unconfirmed); XCTAssertNotNil(model.member); XCTAssertEqual(logouts, 0)
            do { try await model.deleteAccount(confirm: "DELETE", ownedGroups: [], request: { requests += 1; return .object(["ok": .bool(true)]) }, logout: { logouts += 1 }); XCTFail("An uncertain request must not be repeated") } catch {}
            XCTAssertEqual(requests, 1); XCTAssertEqual(logouts, 0)
        }
    }
    @MainActor func testUncertainTransportNeverRetriesAndAcceptedReceiptSurvivesSignout() async throws {
        let model = try model(); var requests = 0
        do { try await model.deleteAccount(confirm: "DELETE", ownedGroups: [], request: { requests += 1; throw URLError(.networkConnectionLost) }, logout: { XCTFail("Unknown delivery cannot sign out as deletion success") }); XCTFail("Transport loss is unconfirmed") } catch {}
        XCTAssertEqual(requests, 1); XCTAssertEqual(model.deletionPhase, .unconfirmed)
        let accepted = try self.model()
        try await accepted.deleteAccount(confirm: "DELETE", ownedGroups: [], request: {
            XCTAssertEqual(accepted.deletionPhase, .submitting)
            return .object(["ok": .bool(true)])
        }, logout: {
            XCTAssertEqual(accepted.deletionPhase, .accepted)
            XCTAssertTrue(accepted.deletionClearingLocalData)
            accepted.member = nil
        })
        XCTAssertNil(accepted.member); XCTAssertEqual(accepted.deletionPhase, .accepted); XCTAssertFalse(accepted.deletionClearingLocalData)
    }
    @MainActor func testKnownRejectionKeepsRecentAuthAndLocalGuards() async throws {
        let model = try model(); var requests = 0
        for confirmation in ["", "delete"] {
            do { try await model.deleteAccount(confirm: confirmation, ownedGroups: [], request: { requests += 1; return .null }); XCTFail("Exact confirmation required") } catch {}
        }
        do { try await model.deleteAccount(confirm: "DELETE", ownedGroups: [.object(["id": .string("owned")])], request: { requests += 1; return .null }); XCTFail("Owned groups must be resolved") } catch {}
        XCTAssertEqual(requests, 0)
        do { try await model.deleteAccount(confirm: "DELETE", ownedGroups: [], request: { requests += 1; throw PorchError.api(code: "RECENT_AUTH_REQUIRED", message: "Sign in again", details: .null) }); XCTFail("Recent authentication is required") } catch { XCTAssertEqual(error.localizedDescription, "Sign in again") }
        XCTAssertEqual(model.deletionPhase, .idle); XCTAssertNotNil(model.member); XCTAssertEqual(requests, 1)
        let held = try self.model("security_hold")
        do { try await held.deleteAccount(confirm: "DELETE", ownedGroups: [], request: { requests += 1; return .null }); XCTFail("Hold must block deletion") } catch {}
        XCTAssertEqual(requests, 1)
    }
    @MainActor func testNewAuthenticationClearsUncertaintyAndRejectsOldAccountCompletion() async throws {
        let model = try model()
        let replacement = try Member(.object(["id": .string("different-member"), "handle": .string("replacement"), "status": .string("active")]))
        model.deletionPhase = .unconfirmed
        model.acceptAuthenticatedMember(replacement)
        XCTAssertEqual(model.deletionPhase, .idle)
        let startingGeneration = model.authenticationGeneration
        var signouts = 0
        try await model.deleteAccount(confirm: "DELETE", ownedGroups: [], request: {
            // A new login, even for the same member, supersedes the pending request.
            model.acceptAuthenticatedMember(replacement)
            return .object(["ok": .bool(true)])
        }, logout: { signouts += 1; model.member = nil })
        XCTAssertGreaterThan(model.authenticationGeneration, startingGeneration)
        XCTAssertEqual(model.member?.id, replacement.id); XCTAssertEqual(model.deletionPhase, .idle); XCTAssertEqual(signouts, 0)
    }
    func testIntegrationSummaryIncludesPurposeScopesLastUseAndRevocation() {
        let value: JSON = .object(["name": .string("Photo archive"), "purpose": .string("Save my own photos"), "scopes": .array([.string("media:read"), .string("export:read")]), "last_used_at": .string("2026-10-25T12:00:00.000Z"), "revoked_at": .null])
        let summary = IntegrationGrantSummary(value)
        XCTAssertEqual(summary.name, "Photo archive"); XCTAssertEqual(summary.purpose, "Save my own photos")
        XCTAssertEqual(summary.scopes, ["media:read", "export:read"]); XCTAssertNotNil(summary.lastUsed); XCTAssertFalse(summary.revoked)
        XCTAssertTrue(IntegrationGrantSummary(value.replacing("revoked_at", with: .string("2026-10-25T13:00:00.000Z"))).revoked)
    }
}

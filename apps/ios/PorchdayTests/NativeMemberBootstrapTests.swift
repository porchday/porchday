import XCTest
@testable import Porchday

final class NativeMemberBootstrapTests: XCTestCase {
    private var account: JSON { .object(["id": .string("synthetic-member"), "handle": .string("synthetic"), "status": .string("active")]) }

    @MainActor func testOneAuthenticatedReadSuppliesMemberAndExplicitEmptyRoster() async throws {
        var paths: [String] = []
        let value = try await NativeMemberBootstrap.fetch { path in
            paths.append(path); return self.account.replacing("startup_devices", with: .array([]))
        }
        XCTAssertEqual(paths, ["/me?bootstrap=1"])
        XCTAssertEqual(value.member.id, "synthetic-member")
        XCTAssertEqual(value.devices, [])
    }

    @MainActor func testOlderServerWithoutRosterRequiresFreshDeviceFallback() async throws {
        let value = try await NativeMemberBootstrap.fetch { _ in self.account }
        XCTAssertNil(value.devices)
    }

    @MainActor func testMalformedRosterCannotBecomeAnEmptyAuthorizedRoster() async {
        for invalid: JSON in [.bool(false), .object([:]), .string("cached")] {
            do {
                _ = try await NativeMemberBootstrap.fetch { _ in self.account.replacing("startup_devices", with: invalid) }
                XCTFail("Malformed roster must fail")
            } catch { XCTAssertFalse(NativeMemberBootstrap.isSignedOut(error)) }
        }
    }

    @MainActor func testDeniedBootstrapDoesNotRetryAnotherAuthenticationEndpoint() async {
        var count = 0
        do {
            _ = try await NativeMemberBootstrap.fetch { _ in
                count += 1; throw PorchError.api(code: "UNAUTHORIZED", message: "Sign in", details: .null)
            }
            XCTFail("Denied session must not publish a member")
        } catch { XCTAssertTrue(NativeMemberBootstrap.isSignedOut(error)) }
        XCTAssertEqual(count, 1)
    }

    @MainActor func testStaleRestoreCannotReplaceOrClearNewerAuthentication() async throws {
        for failure in [false, true] {
            let model = AppModel()
            var pending: CheckedContinuation<JSON, Error>?
            let started = expectation(description: "bootstrap started")
            let task = Task { await model.restore(bootstrapRequest: { _ in
                try await withCheckedThrowingContinuation { continuation in
                    pending = continuation; started.fulfill()
                }
            }) }
            await fulfillment(of: [started], timeout: 5)
            let next = try Member(account.replacing("id", with: .string("new-member")))
            model.acceptAuthenticatedMember(next)
            let response = try XCTUnwrap(pending)
            if failure { response.resume(throwing: URLError(.timedOut)) }
            else { response.resume(returning: account.replacing("startup_devices", with: .array([]))) }
            await task.value
            XCTAssertEqual(model.member?.id, "new-member")
            XCTAssertNil(model.error)
            XCTAssertFalse(model.vault.unlocked)
        }
    }

    func testAccountHoldAndTransportFailuresRemainVisible() {
        XCTAssertFalse(NativeMemberBootstrap.isSignedOut(PorchError.api(code: "ACCOUNT_UNAVAILABLE", message: "Held", details: .null)))
        XCTAssertFalse(NativeMemberBootstrap.isSignedOut(URLError(.timedOut)))
    }
}

import XCTest
@testable import Porchday

final class RecipientKeyVerificationTests: XCTestCase {
    private func row(member: String, id: String = UUID().uuidString.lowercased(), revoked: Bool = false) -> JSON {
        .object(["id": .string(id), "member_id": .string(member), "public_key": .string("synthetic public key"),
                 "fingerprint": .string(String(repeating: "a", count: 64)), "revoked_at": revoked ? .string("2026-01-01T00:00:00.000Z") : .null])
    }

    @MainActor func testOnlyCurrentSelectedPeerDevicesAreDisplayedAndRevocationClearsPreviousSnapshot() async throws {
        let own = UUID().uuidString.lowercased(), peer = UUID().uuidString.lowercased(), other = UUID().uuidString.lowercased()
        let active = try Device(row(member: peer)), revoked = try Device(row(member: peer, revoked: true))
        let unrelated = try Device(row(member: other)), mine = try Device(row(member: own))
        let verification = RecipientKeyVerification()
        await verification.load(memberID: peer, ownMemberID: own) { [mine, revoked, unrelated, active] }
        XCTAssertEqual(verification.status, .available)
        XCTAssertEqual(verification.devices.map(\.id), [active.id])
        XCTAssertEqual(verification.devices.first?.fingerprint, active.fingerprint)
        // The current directory no longer includes that connection. Do not keep a prior successful snapshot.
        await verification.load(memberID: peer, ownMemberID: own) { [mine, unrelated] }
        XCTAssertEqual(verification.status, .unavailable); XCTAssertTrue(verification.devices.isEmpty)
        await verification.load(memberID: peer, ownMemberID: own) { [revoked] }
        XCTAssertEqual(verification.status, .unavailable); XCTAssertTrue(verification.devices.isEmpty)
    }

    @MainActor func testMalformedAndOwnIdentitiesNeverRequestDirectory() async {
        let own = UUID().uuidString.lowercased(), verification = RecipientKeyVerification()
        var calls = 0
        for peer in ["", "../../devices", own] {
            await verification.load(memberID: peer, ownMemberID: own) { calls += 1; return [] }
            XCTAssertEqual(verification.status, .unavailable); XCTAssertTrue(verification.devices.isEmpty)
        }
        XCTAssertEqual(calls, 0)
    }

    @MainActor func testAmbiguousDeviceIdentityAndMalformedFingerprintFailClosed() async throws {
        let own = UUID().uuidString.lowercased(), peer = UUID().uuidString.lowercased()
        let selected = row(member: peer), verification = RecipientKeyVerification()
        let conflicting = selected.replacing("member_id", with: .string(own))
        await verification.load(memberID: peer, ownMemberID: own) { try [selected, conflicting].map(Device.init) }
        XCTAssertEqual(verification.status, .failed); XCTAssertTrue(verification.devices.isEmpty)
        let malformed = selected.replacing("fingerprint", with: .string("incomplete"))
        await verification.load(memberID: peer, ownMemberID: own) { [try Device(malformed)] }
        XCTAssertEqual(verification.status, .failed); XCTAssertTrue(verification.devices.isEmpty)
    }

    @MainActor func testRequestFailureClearsPriorKeysWithoutSurfacingProviderData() async throws {
        let own = UUID().uuidString.lowercased(), peer = UUID().uuidString.lowercased()
        let device = try Device(row(member: peer)), verification = RecipientKeyVerification()
        await verification.load(memberID: peer, ownMemberID: own) { [device] }
        XCTAssertEqual(verification.status, .available)
        await verification.load(memberID: peer, ownMemberID: own) { throw PorchError.api(code: "FORBIDDEN", message: "Synthetic private error detail", details: .null) }
        XCTAssertEqual(verification.status, .failed); XCTAssertTrue(verification.devices.isEmpty)
    }

    @MainActor private final class DeferredDirectory {
        private var requested = false
        private var start: CheckedContinuation<Void, Never>?
        private var response: CheckedContinuation<[Device], Error>?
        func waitForRequest() async {
            if requested { return }
            await withCheckedContinuation { start = $0 }
        }
        func read() async throws -> [Device] {
            requested = true; start?.resume(); start = nil
            return try await withCheckedThrowingContinuation { response = $0 }
        }
        func complete(_ result: Result<[Device], Error>) {
            response?.resume(with: result); response = nil
        }
    }

    @MainActor func testLateResponseCannotReplaceNewSelection() async throws {
        let own = UUID().uuidString.lowercased(), old = UUID().uuidString.lowercased(), current = UUID().uuidString.lowercased()
        let oldDevice = try Device(row(member: old)), currentDevice = try Device(row(member: current))
        let verification = RecipientKeyVerification(), deferred = DeferredDirectory()
        let oldTask = Task { await verification.load(memberID: old, ownMemberID: own) { try await deferred.read() } }
        await deferred.waitForRequest()
        await verification.load(memberID: current, ownMemberID: own) { [currentDevice] }
        deferred.complete(.success([oldDevice])); await oldTask.value
        XCTAssertEqual(verification.status, .available)
        XCTAssertEqual(verification.devices.map(\.id), [currentDevice.id])
    }

    @MainActor func testLateFailureAndDismissalCannotRestoreOldState() async throws {
        let own = UUID().uuidString.lowercased(), peer = UUID().uuidString.lowercased()
        let device = try Device(row(member: peer)), verification = RecipientKeyVerification(), failed = DeferredDirectory()
        let oldTask = Task { await verification.load(memberID: peer, ownMemberID: own) { try await failed.read() } }
        await failed.waitForRequest()
        await verification.load(memberID: peer, ownMemberID: own) { [device] }
        failed.complete(.failure(PorchError.message("Synthetic late failure"))); await oldTask.value
        XCTAssertEqual(verification.status, .available)
        let dismissed = DeferredDirectory()
        let pending = Task { await verification.load(memberID: peer, ownMemberID: own) { try await dismissed.read() } }
        await dismissed.waitForRequest(); verification.cancel()
        dismissed.complete(.success([device])); await pending.value
        XCTAssertEqual(verification.status, .idle); XCTAssertTrue(verification.devices.isEmpty)
    }

    @MainActor func testShippedVaultChecksRealPublicKeysAndKeepsOriginalPinOnMismatchOrReplacement() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "openpgp-v1", withExtension: "json"))
        let fixture = try JSONDecoder().decode(JSON.self, from: Data(contentsOf: url))
        let own = UUID().uuidString.lowercased(), peer = UUID().uuidString.lowercased(), deviceID = UUID().uuidString.lowercased()
        let original = row(member: peer, id: deviceID).replacing("public_key", with: fixture["alice"]["publicKey"]).replacing("fingerprint", with: fixture["alice"]["fingerprint"])
        let pin = "fingerprint:\(peer):\(deviceID)"
        defer { UserDefaults.standard.removeObject(forKey: pin) }
        var directory = original, calls = 0
        let vault = CryptoVault(request: { path, method, body in
            XCTAssertEqual(path, "/audiences?audience=connections"); XCTAssertEqual(method, "GET"); XCTAssertNil(body)
            calls += 1
            return .object(["epoch": .number(1), "devices": .array([directory])])
        }, readStored: { _ in XCTFail("Verification must not unlock keys"); return nil }, writeStored: { _, _ in XCTFail("Verification must not write private keys") })
        let verification = RecipientKeyVerification()
        await verification.load(memberID: peer, ownMemberID: own) { try await vault.audience("connections").1 }
        XCTAssertEqual(verification.status, .available)
        XCTAssertEqual(verification.devices.first?.fingerprint, fixture["alice"]["fingerprint"].string)
        XCTAssertEqual(UserDefaults.standard.string(forKey: pin), fixture["alice"]["fingerprint"].string)
        directory = original.replacing("fingerprint", with: fixture["bob"]["fingerprint"])
        await verification.load(memberID: peer, ownMemberID: own) { try await vault.audience("connections").1 }
        XCTAssertEqual(verification.status, .failed); XCTAssertTrue(verification.devices.isEmpty)
        directory = directory.replacing("public_key", with: fixture["bob"]["publicKey"])
        await verification.load(memberID: peer, ownMemberID: own) { try await vault.audience("connections").1 }
        XCTAssertEqual(verification.status, .failed); XCTAssertTrue(verification.devices.isEmpty)
        XCTAssertEqual(UserDefaults.standard.string(forKey: pin), fixture["alice"]["fingerprint"].string)
        XCTAssertEqual(calls, 3); XCTAssertNil(vault.device); XCTAssertTrue(vault.devices.isEmpty)
    }
}

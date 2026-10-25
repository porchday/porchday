import Foundation
import XCTest
import Porchcrypto
@testable import Porchday

final class CryptoVaultAccessTests: XCTestCase {
    @MainActor private final class Fixture {
        let json: JSON
        let member: Member
        var roster: [JSON]
        var entries: [JSON]
        var requests: [(String, String)] = []
        var stored: [String: Data] = [:]
        var failStorage = false
        var secret: String { json["bob"]["recoverySecret"].string! }
        init(status: String, revoked: Bool = false) throws {
            let url = try XCTUnwrap(Bundle(for: CryptoVaultAccessTests.self).url(forResource: "openpgp-v1", withExtension: "json"))
            let document = try JSONDecoder().decode(JSON.self, from: Data(contentsOf: url))
            json = document
            let recipient = try XCTUnwrap(document["envelope"]["recipients"].array.first { $0["fingerprint"] == document["bob"]["fingerprint"] })
            member = try Member(.object(["id": recipient["memberId"], "handle": .string("synthetic"), "status": .string(status)]))
            let entry = Self.entry(json["bob"], id: recipient["deviceId"])
            entries = [entry]
            roster = [entry.replacing("member_id", with: .string(member.id)).replacing("revoked_at", with: revoked ? .string(PorchDate.string()) : .null)]
        }
        static func entry(_ key: JSON, id: JSON) -> JSON {
            .object(["id": id, "public_key": key["publicKey"], "fingerprint": key["fingerprint"], "encrypted_private_key": key["encryptedPrivateKey"]])
        }
        func vault() -> CryptoVault {
            CryptoVault(request: { [self] path, method, _ in
                requests.append((path, method))
                guard method == "GET" else { throw PorchError.message("Synthetic enrollment boundary") }
                if path == "/devices" { return .object(["items": .array(roster)]) }
                if path == "/keys/backup" { return .object(["envelope": .object(["v": .number(1), "devices": .array(entries)])]) }
                if path == "/devices/" + json["envelope"]["context"]["authorDeviceId"].string! {
                    return Self.entry(json["alice"], id: json["envelope"]["context"]["authorDeviceId"])
                        .replacing("member_id", with: json["envelope"]["context"]["authorId"])
                }
                if path.hasPrefix("/audiences?") { return .object(["epoch": .number(1), "devices": .array(roster.filter { $0["revoked_at"] == .null })]) }
                throw PorchError.message("Unexpected synthetic request")
            }, readStored: { [self] in stored[$0] }, writeStored: { [self] data, account in
                if failStorage { throw PorchError.message("Synthetic storage failure") }
                stored[account] = data
            })
        }
    }

    @MainActor func testFreshRestrictedAndSuspendedRecoveryDecryptsExistingContentWithoutEnrollment() async throws {
        for status in ["restricted", "suspended"] {
            let fixture = try Fixture(status: status, revoked: true), vault = fixture.vault()
            try await vault.load(member: fixture.member); XCTAssertFalse(vault.unlocked)
            try await vault.unlock(member: fixture.member, secret: fixture.secret)
            XCTAssertTrue(vault.unlocked); XCTAssertTrue(vault.device?.revoked == true)
            XCTAssertFalse(vault.canDiscloseEvidence)
            XCTAssertEqual(fixture.requests.map(\.0), ["/devices", "/keys/backup"])
            XCTAssertTrue(fixture.requests.allSatisfy { $0.1 == "GET" })
            XCTAssertNotNil(fixture.stored["device:" + fixture.member.id])
            let opened = try await vault.open(fixture.json["envelope"])
            XCTAssertEqual(opened, fixture.json["payload"])
            let requestCount = fixture.requests.count
            for kind in ["post", "comment", "reaction", "profile", "group", "media", "report"] {
                do {
                    _ = try await vault.seal(.object([:]), member: fixture.member, kind: kind, audience: kind == "report" ? "moderators" : "only_me")
                    XCTFail("A revoked key must not sign new content or evidence")
                } catch { XCTAssertEqual(fixture.requests.count, requestCount) }
            }
            XCTAssertThrowsError(try vault.sign(.object([:])))
            vault.clear()
            let reopened = fixture.vault()
            try await reopened.load(member: fixture.member)
            XCTAssertTrue(reopened.unlocked)
            let reopenedPayload = try await reopened.open(fixture.json["envelope"])
            XCTAssertEqual(reopenedPayload, fixture.json["payload"])
            reopened.clear()
        }
    }

    @MainActor func testRestrictedRecoveryPrefersActiveKeyButKeepsRevokedHistoryAndAllowsOnlyReports() async throws {
        let fixture = try Fixture(status: "restricted", revoked: true)
        let id = UUID().uuidString.lowercased()
        var error: NSError?
        let key = try JSON.parse(PorchcryptoGenerateDeviceKeys(fixture.member.id, id, fixture.secret, &error))
        XCTAssertNil(error)
        let entry = Fixture.entry(key, id: .string(id))
        fixture.entries.append(entry); fixture.roster.append(entry.replacing("member_id", with: .string(fixture.member.id)))
        let vault = fixture.vault()
        try await vault.load(member: fixture.member); try await vault.unlock(member: fixture.member, secret: fixture.secret)
        XCTAssertEqual(vault.device?.id, id); XCTAssertTrue(vault.canDiscloseEvidence)
        let historical = try await vault.open(fixture.json["envelope"])
        XCTAssertEqual(historical, fixture.json["payload"])
        let before = fixture.requests.count
        do {
            _ = try await vault.seal(.object([:]), member: fixture.member, kind: "post", audience: "only_me")
            XCTFail("Restricted members cannot publish")
        } catch { XCTAssertEqual(fixture.requests.count, before) }
        let report = try await vault.seal(.object(["selectedText": .string("Synthetic voluntary evidence")]), member: fixture.member, kind: "report", audience: "moderators")
        XCTAssertEqual(report["context"]["authorDeviceId"], .string(id))
        XCTAssertEqual(report["context"]["kind"], .string("report"))
        XCTAssertTrue(fixture.requests.allSatisfy { $0.1 == "GET" })
        fixture.roster[0] = fixture.roster[0].replacing("revoked_at", with: .null)
        fixture.roster[1] = fixture.roster[1].replacing("revoked_at", with: .string(PorchDate.string()))
        try await vault.load(member: fixture.member)
        XCTAssertEqual(vault.device?.id, fixture.roster[0]["id"].string)
        XCTAssertTrue(vault.canDiscloseEvidence)
        vault.clear()
        let reopened = fixture.vault(); try await reopened.load(member: fixture.member)
        XCTAssertEqual(reopened.device?.id, fixture.roster[0]["id"].string)
        XCTAssertTrue(reopened.canDiscloseEvidence); reopened.clear()
    }

    @MainActor func testRosterRefreshAndRememberedKeysHonorNewRevocation() async throws {
        let fixture = try Fixture(status: "restricted"), vault = fixture.vault()
        try await vault.load(member: fixture.member); try await vault.unlock(member: fixture.member, secret: fixture.secret)
        XCTAssertTrue(vault.canDiscloseEvidence)
        fixture.roster[0] = fixture.roster[0].replacing("revoked_at", with: .string(PorchDate.string()))
        try await vault.load(member: fixture.member)
        XCTAssertTrue(vault.device?.revoked == true); XCTAssertFalse(vault.canDiscloseEvidence)
        let opened = try await vault.open(fixture.json["envelope"])
        XCTAssertEqual(opened, fixture.json["payload"])
        vault.clear()
        let reopened = fixture.vault(); try await reopened.load(member: fixture.member)
        XCTAssertTrue(reopened.unlocked); XCTAssertTrue(reopened.device?.revoked == true)
        XCTAssertFalse(reopened.canDiscloseEvidence); reopened.clear()
    }

    @MainActor func testFailedLocalPersistenceDoesNotPublishUnlockedState() async throws {
        let fixture = try Fixture(status: "restricted"), vault = fixture.vault()
        fixture.failStorage = true
        try await vault.load(member: fixture.member)
        do { try await vault.unlock(member: fixture.member, secret: fixture.secret); XCTFail("Persistence failure must remain visible") }
        catch { XCTAssertFalse(vault.unlocked); XCTAssertTrue(fixture.stored.isEmpty) }
        XCTAssertEqual(fixture.requests.map(\.0), ["/devices", "/keys/backup"])
    }

    @MainActor func testWrongSecretAndMismatchedRosterNeverEnrollOrUnlock() async throws {
        for wrongSecret in [true, false] {
            let fixture = try Fixture(status: "restricted"), vault = fixture.vault()
            if !wrongSecret { fixture.roster = [] }
            try await vault.load(member: fixture.member)
            do { try await vault.unlock(member: fixture.member, secret: wrongSecret ? "wrong-secret" : fixture.secret); XCTFail("Invalid restoration must fail") }
            catch { XCTAssertFalse(vault.unlocked); XCTAssertTrue(fixture.stored.isEmpty) }
            XCTAssertEqual(fixture.requests.map(\.0), ["/devices", "/keys/backup"])
        }
    }

    @MainActor func testActiveRecoveryStillRequiresServerDeviceAuthorization() async throws {
        let fixture = try Fixture(status: "active"), vault = fixture.vault()
        try await vault.load(member: fixture.member)
        do { try await vault.unlock(member: fixture.member, secret: fixture.secret); XCTFail("Synthetic challenge rejection must stop enrollment") }
        catch { XCTAssertFalse(vault.unlocked) }
        XCTAssertEqual(fixture.requests.map(\.0), ["/devices", "/keys/backup", "/devices/challenge"])
        XCTAssertEqual(fixture.requests.last?.1, "POST")
        XCTAssertTrue(fixture.stored.isEmpty)
    }
}

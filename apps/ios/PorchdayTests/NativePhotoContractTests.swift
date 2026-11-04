import XCTest
@testable import Porchday

final class NativePhotoContractTests: XCTestCase {
    func testDatesCannotOverflowOrApplyToPostDates() throws {
        XCTAssertEqual(try NativePhotoContract.date("2024-02-29"), "2024-02-29")
        for value in ["2023-02-29", "2024-02-30", "0000-01-01", "2024-2-01", "tomorrow"] { XCTAssertThrowsError(try NativePhotoContract.date(value)) }
    }
    func testAuthorFiltersIncludeSelfAndSeparateMutualFamily() {
        let own: JSON = .object(["author_id": .string("me")])
        for choice in ["me", "friends", "family", "connections", "extended_family", "community"] { XCTAssertTrue(NativePhotoContract.matchesAuthor(own, selection: choice, member: "me")) }
        let peer: JSON = .object(["author_id": .string("peer"), "author_category": .string("friends"), "author_in_extended_family": .bool(false)])
        XCTAssertTrue(NativePhotoContract.matchesAuthor(peer, selection: "connections", member: "me"))
        XCTAssertFalse(NativePhotoContract.matchesAuthor(peer, selection: "family", member: "me"))
        XCTAssertFalse(NativePhotoContract.matchesAuthor(peer, selection: "me", member: "me"))
        XCTAssertFalse(NativePhotoContract.matchesAuthor(peer, selection: "extended_family", member: "me"))
        XCTAssertTrue(NativePhotoContract.matchesAuthor(peer.replacing("author_in_extended_family", with: .bool(true)), selection: "extended_family", member: "me"))
    }
    func testPhotoProofExcludesGrantSpecificMediaID() throws {
        let metadata: JSON = .object(["id": .string("media"), "alt": .string("A photo"), "tags": .array([])])
        let proof = try NativePhotoContract.statement(id: "photo", owner: "owner", device: "device", revision: 2, date: "2024-02-29", expiry: .null, hash: NativePhotoContract.hash(Data("hello".utf8)), media: metadata)
        XCTAssertEqual(proof["metadata"]["id"], .null)
        XCTAssertEqual(proof["metadata"]["alt"].string, "A photo")
        XCTAssertEqual(proof["sha256"].string, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
        XCTAssertNotEqual(proof, proof.replacing("date", with: .string("2024-03-01")))
    }
    @MainActor func testInvitationHistoryIsExplicitInBothDirections() async throws {
        let member = try Member(.object(["id": .string("member"), "handle": .string("person"), "status": .string("active")]))
        for history in ConnectionHistory.allCases {
            _ = try await PlatformInvitation.send(email: "person@example.test", member: member, kind: "family", history: history) { _, body in
                XCTAssertEqual(body["history"].string, history.rawValue)
                XCTAssertEqual(body["kind"].string, "family")
                return .object(["accepted": .bool(true)])
            }
        }
    }
}

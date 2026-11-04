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
    func testWebAndLegacyNativeCaptionsRemainVisibleWithoutDuplicates() {
        XCTAssertEqual(NativePhotoContract.captions(.object(["alt": .string("Web caption")])), ["Web caption"])
        XCTAssertEqual(NativePhotoContract.captions(.object(["caption": .string("Native caption")])), ["Native caption"])
        XCTAssertEqual(NativePhotoContract.captions(.object(["alt": .string("Same"), "caption": .string("Same")])), ["Same"])
        XCTAssertEqual(NativePhotoContract.captions(.object(["alt": .string("Description"), "caption": .string("Legacy")])), ["Description", "Legacy"])
    }
    func testEditingCaptionAndTagsPreservesMediaIdentityAndFormat() {
        let original: JSON = .object(["id": .string("grant-specific-media"), "mime": .string("image/jpeg"), "width": .number(16), "alt": .string("Old caption"), "poster": .string("poster")])
        let edited = NativePhotoContract.editMetadata(original, alt: "New caption", caption: "Legacy caption", tags: [])
        XCTAssertEqual(edited["id"], original["id"]); XCTAssertEqual(edited["mime"], original["mime"])
        XCTAssertEqual(edited["width"], original["width"]); XCTAssertEqual(edited["poster"], original["poster"])
        XCTAssertEqual(edited["alt"].string, "New caption"); XCTAssertEqual(edited["caption"].string, "Legacy caption")
        XCTAssertNotEqual(NativePhotoContract.metadata(original), NativePhotoContract.metadata(edited))
    }
    func testAttachmentExportReferenceRetainsEffectiveDeadline() {
        let row: JSON = .object(["media_id": .string("media"), "revision": .number(2), "effective_expires_at": .string("2027-01-01T00:00:00.000Z"), "expires_at": .string("2028-01-01T00:00:00.000Z")])
        let reference = NativeArchiveIdentity.reference(row, kind: "attachment_date")
        XCTAssertEqual(reference["id"].string, "media")
        XCTAssertEqual(reference["expires_at"].string, "2027-01-01T00:00:00.000Z")
        XCTAssertEqual(reference["revision"].integer, 2)
    }
    func testArchiveIdentityMatchesWebImporterAndIsAccountScoped() throws {
        XCTAssertEqual(try NativeArchiveIdentity.id(owner: "owner", source: "source", kind: "photo", id: "id"), "04a099e7-eef6-544c-a940-8c476e51e182")
        XCTAssertNotEqual(try NativeArchiveIdentity.id(owner: "other", source: "source", kind: "photo", id: "id"), try NativeArchiveIdentity.id(owner: "owner", source: "source", kind: "photo", id: "id"))
    }
    @MainActor func testPhotoAlbumArchiveRoundTripAndMissingMediaFailsClosed() throws {
        let owner = UUID().uuidString.lowercased(), photo = UUID().uuidString.lowercased(), album = UUID().uuidString.lowercased(), media = UUID().uuidString.lowercased()
        let bytes = Data([1,2,3]), path = "photos/" + media + ".jpg"
        let record: JSON = .object(["id": .string(photo), "created_at": .string(PorchDate.string()), "photo_date": .string("2024-02-29"), "expires_at": .null, "album_ids": .array([.string(album)]), "payload": .object(["media": .array([.object(["id": .string(media)])])])])
        let manifest: JSON = .object(["format": .string("porchday-archive"), "version": .number(1), "member_id": .string(owner), "photos": .array([record]), "albums": .array([.object(["id": .string(album), "created_at": .string(PorchDate.string()), "payload": .object(["name": .string("Our album")])])]), "attachment_dates": .array([]), "media": .array([.object(["id": .string(media), "path": .string(path), "mime": .string("image/jpeg"), "sha256": .string(PortableArchive.digest(bytes))])])])
        let archive = PortableArchive(manifest: manifest, files: [path: bytes])
        let reopened = try PortableArchive.read(archive.zip())
        XCTAssertEqual(reopened.manifest, manifest)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".zip")
        defer { try? FileManager.default.removeItem(at: url) }
        try archive.zip().write(to: url)
        let selection = try ArchiveSelection.load(urls: [url], secret: "")
        defer { try? FileManager.default.removeItem(at: selection.urls[0].deletingLastPathComponent()) }
        XCTAssertEqual(selection.orphanPhotoIDs, [])
        XCTAssertEqual(try selection.collection("photos"), [record])
        try PortableArchive(manifest: manifest.replacing("media", with: .array([])), files: [:]).zip().write(to: url)
        XCTAssertThrowsError(try ArchiveSelection.load(urls: [url], secret: ""))
        XCTAssertThrowsError(try PortableArchive.requireSupportedCollections(manifest.replacing("photos", with: .array([record.replacing("photo_date", with: .string("2024-02-30"))]))))
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

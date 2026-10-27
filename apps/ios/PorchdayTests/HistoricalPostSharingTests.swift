import XCTest
@testable import Porchday

final class HistoricalPostSharingTests: XCTestCase {
    func testNewChoicesRecommendFullWithoutUpgradingExistingConnections() {
        XCTAssertEqual(ConnectionHistory.newConnectionDefault, .full)
        XCTAssertEqual(ConnectionHistory.full.title, "Share full history (recommended)")
        XCTAssertEqual(ConnectionHistory.future.title, "Only share new posts")
        XCTAssertEqual(ConnectionHistory.persisted(.null), .future)
        XCTAssertEqual(ConnectionHistory.persisted(.string("unknown")), .future)
        XCTAssertEqual(ConnectionHistory.persisted(.string("future")), .future)
        XCTAssertEqual(ConnectionHistory.persisted(.string("full")), .full)
    }

    @MainActor func testTextPreservesIdentityDeadlinePayloadAndUsesHistorySnapshot() async throws {
        let f = HistoryFixture()
        let original = f.source
        try await f.refresh()
        let body = try XCTUnwrap(f.published.first)
        let updated = body["envelope"]
        XCTAssertEqual(f.published.count, 1)
        XCTAssertEqual(updated["context"]["id"], original["id"])
        XCTAssertEqual(updated["context"]["createdAt"], original["envelope"]["context"]["createdAt"])
        XCTAssertEqual(updated["context"]["expiresAt"], original["expires_at"])
        XCTAssertEqual(updated["context"]["revision"].integer, 4)
        XCTAssertEqual(updated["test_payload"], original["envelope"]["test_payload"])
        XCTAssertEqual(body["source_revision"].integer, 3)
        XCTAssertEqual(body["source_expires_at"], original["expires_at"])
        XCTAssertEqual(body["source_media_ids"], .array([]))
        XCTAssertEqual(body["media_ids"], .array([]))
        XCTAssertEqual(body["lifecycle"]["signed"]["id"], original["id"])
        XCTAssertEqual(body["lifecycle"]["signed"]["revision"].integer, 4)
        XCTAssertEqual(f.snapshots, [f.audience])
        XCTAssertEqual(f.audienceReads, 1)
        XCTAssertEqual(f.reads, 2)
    }

    @MainActor func testPhotosUseFreshIDsAndDeadlineAndDropExpiredReferences() async throws {
        let f = HistoryFixture()
        f.addPhoto()
        let originalPayload = f.source["envelope"]["test_payload"]
        let oldPhoto = originalPayload["media"].array[0]
        try await f.refresh()
        let reservation = try XCTUnwrap(f.reservations.first)
        let newID = try XCTUnwrap(reservation["id"].string)
        XCTAssertNotEqual(newID, f.photoID)
        XCTAssertNotNil(UUID(uuidString: newID))
        XCTAssertEqual(reservation["history_post_id"].string, f.postID)
        XCTAssertEqual(reservation["history_source_revision"].integer, 3)
        XCTAssertEqual(reservation["envelope"]["context"]["expiresAt"], f.photoExpiry)
        XCTAssertEqual(reservation["envelope"]["context"]["parentId"].string, f.postID)
        XCTAssertEqual(reservation["envelope"]["context"]["revision"].integer, 1)
        XCTAssertNotEqual(reservation["envelope"]["context"]["createdAt"], f.source["envelope"]["context"]["createdAt"])
        XCTAssertEqual(reservation["envelope"]["test_payload"]["id"].string, newID)
        XCTAssertEqual(f.photoReads, [f.photoID])
        XCTAssertEqual(f.validations, 1)
        XCTAssertEqual(f.uploads.count, 1)
        XCTAssertEqual(f.uploads.first?.0, "/api/v1/media/\(newID)/bytes")
        XCTAssertEqual(f.uploads.first?.1.count, reservation["byte_size"].integer)
        let body = try XCTUnwrap(f.published.first)
        XCTAssertEqual(body["source_media_ids"], .array([.string(f.photoID)]))
        XCTAssertEqual(body["media_ids"], .array([.string(newID)]))
        XCTAssertEqual(body["envelope"]["test_payload"]["media"], .array([oldPhoto.replacing("id", with: .string(newID))]))
        XCTAssertEqual(body["envelope"]["test_payload"]["reactionSecret"], originalPayload["reactionSecret"])
        XCTAssertEqual(f.snapshots, [f.audience, f.audience])
    }

    @MainActor func testLostSuccessfulResponseUsesExactReadbackWithoutRetry() async throws {
        let f = HistoryFixture(); f.loseWriteResponse = true
        try await f.refresh()
        XCTAssertEqual(f.published.count, 1)
        XCTAssertEqual(f.reads, 2)
    }

    @MainActor func testOriginalAndReplacementPhotoIDsStayPairedInPayloadOrder() async throws {
        let f = HistoryFixture(); f.addPhoto()
        let secondID = "44444444-4444-4444-8444-444444444444"
        let second = f.photo.replacing("context", with: f.photo["context"].replacing("id", with: .string(secondID)).replacing("expiresAt", with: .null))
            .replacing("test_payload", with: f.photo["test_payload"].replacing("id", with: .string(secondID)))
        f.photoEnvelopes[secondID] = second
        let originalMedia = f.source["media"].array
        f.source = f.source.replacing("media", with: .array(originalMedia + [.object(["id": .string(secondID), "envelope": second])]))
        let payload = f.source["envelope"]["test_payload"]
        let references = [.object(["id": JSON.string(secondID)])] + payload["media"].array
        f.source = f.source.replacing("envelope", with: f.source["envelope"].replacing("test_payload", with: payload.replacing("media", with: .array(references))))
        try await f.refresh()
        let body = try XCTUnwrap(f.published.first)
        XCTAssertEqual(body["source_media_ids"], .array([.string(secondID), .string(f.photoID)]))
        XCTAssertEqual(body["media_ids"], .array(f.reservations.map { $0["id"] }))
        XCTAssertEqual(f.reservations[0]["envelope"]["context"]["expiresAt"], f.source["expires_at"])
        XCTAssertEqual(f.reservations[1]["envelope"]["context"]["expiresAt"], f.photoExpiry)
    }

    @MainActor func testUncertainWriteAndUnavailableReadbackStopsWithoutRetry() async throws {
        let f = HistoryFixture(); f.addPhoto(); f.loseWriteResponse = true; f.failReadback = true
        do { try await f.refresh(); XCTFail("Expected unconfirmed result") }
        catch { XCTAssertEqual(error.localizedDescription, HistoricalPostSharing.unconfirmed) }
        XCTAssertEqual(f.published.count, 1)
        XCTAssertEqual(f.reservations.count, 1)
        XCTAssertEqual(f.uploads.count, 1)
    }

    @MainActor func testReadbackMustMatchAttachmentsAsWellAsEnvelope() async throws {
        let f = HistoryFixture(); f.addPhoto(); f.wrongReadbackAttachments = true
        do { try await f.refresh(); XCTFail("Expected unconfirmed attachment update") }
        catch { XCTAssertEqual(error.localizedDescription, HistoricalPostSharing.unconfirmed) }
        XCTAssertEqual(f.published.count, 1)
    }

    @MainActor func testCancellationAfterReservationDoesNotUploadOrPublish() async throws {
        let f = HistoryFixture(); f.addPhoto(); f.cancelAfterReserve = true
        do { try await f.refresh(); XCTFail("Expected cancellation") }
        catch is CancellationError { }
        XCTAssertEqual(f.reservations.count, 1)
        XCTAssertTrue(f.uploads.isEmpty)
        XCTAssertTrue(f.published.isEmpty)
    }

    @MainActor func testIneligibleSourceNeverRequestsAudienceOrWrites() async throws {
        for field in ["other-author", "group", "only-me", "expired"] {
            let f = HistoryFixture()
            switch field {
            case "other-author": f.source = f.source.replacing("author_id", with: .string("someone-else"))
            case "group": f.replaceContext("groupId", .string("some-group"))
            case "only-me": f.replaceContext("audience", .string("only_me"))
            default:
                let expired = JSON.string("2000-01-01T00:00:00.000Z")
                f.replaceContext("expiresAt", expired); f.source = f.source.replacing("expires_at", with: expired)
            }
            do { try await f.refresh(); XCTFail("Accepted \(field)") } catch { }
            XCTAssertEqual(f.audienceReads, 0)
            XCTAssertTrue(f.published.isEmpty)
        }
    }

    @MainActor func testMissingLivePhotoReferenceAndUnreadyAudienceDoNotWrite() async throws {
        let f = HistoryFixture(); f.addPhoto()
        f.source = f.source.replacing("envelope", with: f.source["envelope"].replacing("test_payload", with: f.source["envelope"]["test_payload"].replacing("media", with: .array([]))))
        do { try await f.refresh(); XCTFail("Accepted missing photo") } catch { }
        XCTAssertTrue(f.reservations.isEmpty); XCTAssertTrue(f.published.isEmpty)
        let pending = HistoryFixture(); pending.audience = pending.audience.replacing("pending_members", with: .array([.string("not-ready")]))
        do { try await pending.refresh(); XCTFail("Accepted unready audience") } catch { }
        XCTAssertTrue(pending.snapshots.isEmpty); XCTAssertTrue(pending.published.isEmpty)
    }
}

/// Injected sealing exercises the native workflow and its exact binding inputs;
/// the shared crypto suites verify real signatures and ciphertext interoperability.
@MainActor private final class HistoryFixture {
    let postID = "11111111-1111-4111-8111-111111111111"
    let memberID = "22222222-2222-4222-8222-222222222222"
    let photoID = "33333333-3333-4333-8333-333333333333"
    let photoExpiry: JSON = .string("2099-01-02T00:00:00.000Z")
    var source: JSON = .null
    var committed: JSON?
    var audience: JSON = .object(["epoch": .number(8), "devices": .array([.object(["id": .string("owner-device")]), .object(["id": .string("consented-friend-device")])]), "pending_members": .array([])])
    var photo: JSON = .null
    var photoEnvelopes: [String: JSON] = [:]
    var reads = 0, audienceReads = 0, validations = 0
    var photoReads: [String] = [], snapshots: [JSON] = [], reservations: [JSON] = [], published: [JSON] = []
    var uploads: [(String, Data)] = []
    var loseWriteResponse = false, failReadback = false, wrongReadbackAttachments = false
    var cancelAfterReserve = false, cancelled = false
    init() {
        let context: JSON = .object(["id": .string(postID), "kind": .string("post"), "authorId": .string(memberID), "authorDeviceId": .string("original-device"), "audience": .string("connections"), "parentId": .null, "groupId": .null, "createdAt": .string("2020-01-01T00:00:00.000Z"), "expiresAt": .string("2099-01-03T00:00:00.000Z"), "revision": .number(3), "epoch": .number(2)])
        source = .object(["id": .string(postID), "author_id": .string(memberID), "expires_at": context["expiresAt"], "group_id": .null, "envelope": .object(["context": context, "test_payload": .object(["text": .string("Earlier post"), "reactionSecret": .string("test-only-preserved-secret"), "otherField": .string("preserve")])]), "media": .array([])])
    }
    func replaceContext(_ key: String, _ value: JSON) {
        source = source.replacing("envelope", with: source["envelope"].replacing("context", with: source["envelope"]["context"].replacing(key, with: value)))
    }
    func addPhoto() {
        let context = source["envelope"]["context"].replacing("id", with: .string(photoID)).replacing("kind", with: .string("media")).replacing("parentId", with: .string(postID)).replacing("expiresAt", with: photoExpiry)
        photo = .object(["context": context, "recipients": .array([.string("original-device")]), "test_payload": .object(["id": .string(photoID), "mime": .string("image/jpeg"), "bytes": .string("test-image-bytes")])])
        photoEnvelopes[photoID] = photo
        source = source.replacing("media", with: .array([.object(["id": .string(photoID), "envelope": photo])]))
        let refs: JSON = .array([.object(["id": .string(photoID), "alt": .string("Keep caption"), "width": .number(10)]), .object(["id": .string("expired-photo")])])
        source = source.replacing("envelope", with: source["envelope"].replacing("test_payload", with: source["envelope"]["test_payload"].replacing("media", with: refs)))
    }
    func refresh() async throws { try await HistoricalPostSharing.refresh(postID: postID, memberID: memberID, io: io) }
    var io: HistoricalPostSharing.IO { .init(
        readPost: { [self] id in
            XCTAssertEqual(id, postID); reads += 1
            if reads > 1 && failReadback { throw PorchError.message("Network unavailable") }
            return .object(["post": committed ?? source])
        }, readAudience: { [self] id in XCTAssertEqual(id, postID); audienceReads += 1; return audience },
        readPhoto: { [self] id in photoReads.append(id); return try XCTUnwrap(photoEnvelopes[id]) },
        open: { $0["envelope"]["test_payload"] },
        seal: { [self] payload, context, snapshot in snapshots.append(snapshot); return .object(["context": context, "test_payload": payload]) },
        sign: { .object(["signed": $0]) },
        reservePhoto: { [self] body in
            reservations.append(body)
            if cancelAfterReserve { cancelled = true }
            return .object(["upload_url": .string("/api/v1/media/" + (body["id"].string ?? "") + "/bytes")])
        }, uploadPhoto: { [self] path, bytes in uploads.append((path, bytes)) },
        publish: { [self] id, body in
            XCTAssertEqual(id, postID); published.append(body)
            committed = source.replacing("envelope", with: body["envelope"]).replacing("media", with: .array(wrongReadbackAttachments ? [] : body["media_ids"].array.map { .object(["id": $0]) }))
            if loseWriteResponse { throw PorchError.message("Response lost") }
            return .object(["ok": .bool(true)])
        }, validatePhoto: { [self] _ in validations += 1 },
        check: { [self] in if cancelled { throw CancellationError() } }) }
}

import XCTest
@testable import Porchday

final class PhotoUploadTests: XCTestCase {
    @MainActor func testPartialBatchManualRetryUsesFreshMediaAndKeepsSelections() async throws {
        let photos = [PreparedPhoto(bytes: Data([1, 2, 3]), width: 10, height: 20, alt: "First photo"),
                      PreparedPhoto(bytes: Data([4, 5, 6]), width: 30, height: 40, alt: "Second photo")]
        let selectionIDs = photos.map(\.id)
        var parent = "first-post", shouldFail = true, reservations: [JSON] = [], writes: [JSON] = [], sequence: [String] = []
        @MainActor func uploadBatch() async throws -> [JSON] {
            var result: [JSON] = []
            for photo in photos {
                result.append(try await PhotoUpload.upload(photo, seal: { payload, id in
                    // Injected sealing records the binding passed by production
                    // code; the separate crypto suite verifies actual encryption.
                    .object(["context": .object(["id": .string(id), "parentId": .string(parent)]), "test_payload": payload])
                }, reserve: { body in
                    let id = try XCTUnwrap(body["id"].string)
                    if reservations.contains(where: { $0["id"].string == id }) { throw PorchError.api(code: "CONFLICT", message: "Duplicate media identity", details: .null) }
                    XCTAssertEqual(body["id"], body["envelope"]["context"]["id"])
                    XCTAssertEqual(body["id"], body["envelope"]["test_payload"]["id"])
                    reservations.append(body); sequence.append("reserve")
                    return .object(["upload_url": .string("/api/v1/media/" + id + "/bytes")])
                }, put: { path, bytes in
                    let envelope = try JSONDecoder().decode(JSON.self, from: bytes), id = try XCTUnwrap(envelope["context"]["id"].string)
                    XCTAssertEqual(path, "/api/v1/media/" + id + "/bytes")
                    XCTAssertEqual(reservations.last?["byte_size"].integer, bytes.count)
                    XCTAssertEqual(reservations.last?["envelope"], envelope)
                    writes.append(envelope); sequence.append("put")
                    if shouldFail && writes.count == 2 { throw PorchError.api(code: "MEDIA_BUSY", message: "media busy", details: .null) }
                }))
            }
            return result
        }
        do { _ = try await uploadBatch(); XCTFail("Expected the second PUT to fail") }
        catch PorchError.api(let code, _, _) { XCTAssertEqual(code, "MEDIA_BUSY") }
        XCTAssertEqual(reservations.count, 2)
        shouldFail = false; parent = "retried-post"
        let completed = try await uploadBatch()
        XCTAssertEqual(reservations.count, 4)
        XCTAssertEqual(Set(reservations.compactMap { $0["id"].string }).count, 4)
        XCTAssertEqual(completed.map { $0["id"] }, reservations.suffix(2).map { $0["id"] })
        XCTAssertEqual(writes.prefix(2).map { $0["context"]["parentId"].string }, ["first-post", "first-post"])
        XCTAssertEqual(writes.suffix(2).map { $0["context"]["parentId"].string }, ["retried-post", "retried-post"])
        XCTAssertEqual(sequence, ["reserve", "put", "reserve", "put", "reserve", "put", "reserve", "put"])
        XCTAssertEqual(photos.map(\.id), selectionIDs)
        XCTAssertEqual(photos.map(\.alt), ["First photo", "Second photo"])
        XCTAssertTrue(Set(selectionIDs).isDisjoint(with: Set(reservations.compactMap { $0["id"].string })))
        XCTAssertEqual(completed[0]["alt"].string, "First photo")
        XCTAssertEqual(completed[1]["height"].integer, 40)
    }

    @MainActor func testBusyReservationDoesNotUploadOrAutomaticallyRetry() async throws {
        let photo = PreparedPhoto(bytes: Data([1]), width: 1, height: 1)
        var reservations = 0, writes = 0
        do {
            _ = try await PhotoUpload.upload(photo, seal: { payload, _ in payload }, reserve: { _ in
                reservations += 1
                throw PorchError.api(code: "MEDIA_BUSY", message: "media busy", details: .null)
            }, put: { _, _ in writes += 1 })
            XCTFail("Expected a busy reservation")
        } catch PorchError.api(let code, _, _) { XCTAssertEqual(code, "MEDIA_BUSY") }
        XCTAssertEqual(reservations, 1); XCTAssertEqual(writes, 0)
        let message = PorchError.api(code: "MEDIA_BUSY", message: "media busy", details: .null).localizedDescription
        XCTAssertTrue(message.contains("Wait a moment, then try again"))
        XCTAssertTrue(message.contains("draft and selected photos are still here"))
    }
}

import XCTest
import ImageIO
@testable import Porchday

final class AppleParityTests: XCTestCase {
    func testCalendarUsesLocalCivilDaysAcrossDaylightSaving() throws {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles")); calendar.firstWeekday = 1
        let november = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 11, day: 1)))
        let cells = PhotoCalendar.cells(november, calendar: calendar).compactMap { $0 }
        XCTAssertEqual(cells.count, 30)
        XCTAssertEqual(PhotoCalendar.day(cells.last!, calendar: calendar), "2026-11-30")
        XCTAssertEqual(Set(cells.map { PhotoCalendar.day($0, calendar: calendar) }).count, 30)
    }
    func testCalendarAPIKeysStayGregorianWithBuddhistDisplayCalendar() throws {
        var calendar = Calendar(identifier: .buddhist)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        let date = try XCTUnwrap(calendar.date(from: DateComponents(year: 2569, month: 11, day: 1)))
        XCTAssertEqual(PhotoCalendar.day(date, calendar: calendar), "2026-11-01")
    }
    func testTagsRejectInvalidIdentitiesAndKeepMemberChildDistinct() {
        let id = UUID().uuidString.lowercased()
        XCTAssertNil(PersonTag(.object(["id": .string("bad"), "kind": .string("member"), "label": .string("someone")])))
        let member = PersonTag(.object(["id": .string(id), "kind": .string("member"), "label": .string("a")]))!
        let child = PersonTag(.object(["id": .string(id), "kind": .string("child"), "label": .string("a")]))!
        XCTAssertNotEqual(member.id, child.id)
        XCTAssertEqual(PersonTag.parse(.array(Array(repeating: member.json, count: 40))).count, 30)
    }
    func testVideoContainerRejectsArbitraryBytesAndOversizedInput() {
        XCTAssertThrowsError(try VideoContainer.mime(Data("not a video.mp4".utf8)))
        XCTAssertThrowsError(try VideoContainer.mime(Data(repeating: 0, count: VideoContainer.maximumBytes + 1)))
        var mp4 = Data([0, 0, 0, 20]); mp4.append(Data("ftypisom".utf8)); mp4.append(Data([0, 0, 0, 0])); mp4.append(Data("mp42".utf8))
        XCTAssertEqual(try VideoContainer.mime(mp4), "video/mp4")
        mp4[0] = 0xff
        XCTAssertThrowsError(try VideoContainer.mime(mp4))
    }
    func testMentionsDoNotResolveEmailOrUnknownHandleOrDuplicate() {
        let person = PersonTag(.object(["id": .string(UUID().uuidString), "kind": .string("member"), "label": .string("nick")]))!
        XCTAssertTrue(NativeMentions.resolve("email@nick and @unknown", directory: [person], existing: []).isEmpty)
        XCTAssertEqual(NativeMentions.resolve("Hi @Nick, and @nick!", directory: [person], existing: []), [person])
    }
    @MainActor func testVideoDecoderRejectsFakeContainer() async {
        var header = Data([0, 0, 0, 20]); header.append(Data("ftypisom".utf8)); header.append(Data([0, 0, 0, 0])); header.append(Data("mp42".utf8))
        do { _ = try await VideoPipeline.prepare(header); XCTFail("A container header is not a playable video") } catch { }
    }
    @MainActor func testLocalWebMDecodesSyntheticClipWithoutPersistentStorage() async throws {
        // ffmpeg lavfi solid blue, 16x16, 0.4 seconds, VP9; no member media.
        try await assertBlueWebM("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAILEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggH17AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAwV0GNTGF2ZjYyLjEyLjEwMESJiEB5AAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYg2p8PcJT6AWpyBACK1nIN1bmSIgQCGhVZfVlA5g4EBI+ODhAvrwgDgkLCBELqBEJqBAlWwhFW5gQESVMNnQIBzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYyLjEyLjEwMHNz2mPAi2PFiDanw9wlPoBaZ8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4yOC4xMDAgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuNDAwMDAwMDAwAB9DtnXF54EAo6uBAACAgkmDQgAA8AD2ADgkHBhKAAAwYAAAEL///BCx/////yKs///+f8AAo5OBAMgAhgBAkpwAUAAAAyAAAEJAHFO7a5G7j7OBALeK94EB8YIBq/CBAw==")
    }
    @MainActor func testLocalWebMAcceptsStreamingDurationLikeWebClient() async throws {
        // The web contract accepts Infinity (streaming WebM), but never NaN.
        try await assertBlueWebM("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwH/////////EU2bdKtNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHNTbuMU6uEElTDZ1OsggEa7AEAAAAAAABoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmpyrXsYMPQkBNgI1MYXZmNjIuMTIuMTAwV0GNTGF2ZjYyLjEyLjEwMBZUrmvIrgEAAAAAAAA/14EBc8WIBDHx1sEN5V+cgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4QL68IA4JCwgRC6gRCagQJVsIRVuYEBElTDZ9xzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYyLjEyLjEwMHNztmPAi2PFiAQx8dbBDeVfZ8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4yOC4xMDAgbGlidnB4LXZwOR9DtnXF54EAo6uBAACAgkmDQgAA8AD2ADgkHBhKAAAwYAAAEL///BCx/////yKs///+f8AAo5OBAMgAhgBAkpwAUAAAAyAAAEJA")
    }
    @MainActor private func assertBlueWebM(_ encoded: String) async throws {
        #if targetEnvironment(simulator)
        // Upstream WebKit disables VP9DecoderEnabled in its iOS simulator
        // test runner. Hardware acceptance remains required; never count this
        // skip as successful iPhone playback. See docs/native-apple-parity.md.
        throw XCTSkip("VP9 requires the physical iPhone acceptance run; WebKit disables this decoder in its simulator test runner")
        #else
        let bytes = try XCTUnwrap(Data(base64Encoded: encoded))
        let decoder = LocalWebM(); defer { decoder.stop() }
        XCTAssertFalse(decoder.view.configuration.websiteDataStore.isPersistent)
        let clip = try await decoder.open(bytes)
        XCTAssertEqual(clip.mime, "video/webm")
        XCTAssertEqual(clip.width, 16); XCTAssertEqual(clip.height, 16)
        let poster = try XCTUnwrap(Data(base64Encoded: clip.poster))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(poster as CFData, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        var pixel = [UInt8](repeating: 0, count: 4)
        try pixel.withUnsafeMutableBytes { buffer in
            let context = try XCTUnwrap(CGContext(data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        XCTAssertGreaterThan(pixel[2], 150, "The thumbnail must contain the decoded blue frame, not a blank canvas")
        XCTAssertLessThan(pixel[0], 50); XCTAssertLessThan(pixel[1], 50)
        #endif
    }
    func testPrivatePlaybackFileIsRemovedAndNotWorldReadable() throws {
        var file: PrivateMediaFile? = try PrivateMediaFile(Data([1, 2, 3]), ext: "mp4")
        let url = try XCTUnwrap(file?.url)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        file = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
    func testArchiveMediaExtensionsAreClosedSet() throws {
        XCTAssertEqual(try PortableArchive.mediaExtension("video/quicktime"), "mov")
        XCTAssertThrowsError(try PortableArchive.mediaExtension("text/html"))
    }
    func testExpiredAndFilteredRowsCannotBeSelectedAsHighlights() {
        let date = Date()
        let row = SocialItem(id: "p", raw: .object(["author_id": .string("a"), "expires_at": .string(PorchDate.string(date.addingTimeInterval(-1)))]), envelope: .null, payload: .object(["text": .string("expired")]), error: nil)
        XCTAssertTrue(PhotoCalendar.filtered([row], author: "", tag: "", now: date).isEmpty)
        XCTAssertNil(PhotoCalendar.featured([], choice: .object(["post_id": .string("p")])))
    }
}

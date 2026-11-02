import XCTest
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

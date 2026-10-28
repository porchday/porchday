import XCTest
@testable import Porchday

final class DisplayPreferencesTests: XCTestCase {
    func testUnknownPreferencesFallBackToDevice() {
        XCTAssertNil(DisplayPreferences.colorScheme("future"))
        XCTAssertNil(DisplayPreferences.colorScheme("system"))
        XCTAssertEqual(DisplayPreferences.colorScheme("dark"), .dark)
        XCTAssertEqual(DisplayPreferences.colorScheme("light"), .light)
        XCTAssertEqual(DisplayPreferences.timeZone("invalid-zone"), .autoupdatingCurrent)
    }
    func testDisplayTimezoneDoesNotChangeDeadline() {
        let deadline = Date(timeIntervalSince1970: 1_800_000_000)
        let original = PorchDate.string(deadline)
        XCTAssertNotEqual(DisplayPreferences.date(deadline, zone: "UTC"), DisplayPreferences.date(deadline, zone: "America/Los_Angeles"))
        XCTAssertEqual(PorchDate.string(deadline), original)
        XCTAssertEqual(DisplayPreferences.timeZone("UTC").secondsFromGMT(for: deadline), 0)
    }
}

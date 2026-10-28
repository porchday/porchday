import XCTest
@testable import Porchday

final class ProfileVisibilityTests: XCTestCase {
    func testExistingPrivateProfileStaysPrivate() throws {
        XCTAssertEqual(try ProfileVisibility.read(.object(["audience": .string("only_me")])), "only_me")
        XCTAssertEqual(try ProfileVisibility.read(.object(["audience": .string("connections")])), "connections")
    }
    func testNewProfileDefaultAndUnsupportedExistingVisibility() throws {
        XCTAssertEqual(try ProfileVisibility.read(.null), "connections")
        XCTAssertThrowsError(try ProfileVisibility.read(.object([:])))
        XCTAssertThrowsError(try ProfileVisibility.read(.object(["audience": .string("future-audience")])))
    }
}

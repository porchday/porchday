import Foundation
import XCTest
@testable import Porchday

final class ServerConfigurationTests: XCTestCase {
    func testDefaultAddressRemainsProduction() {
        XCTAssertFalse(ServerConfiguration.hostedStagingTestEnabled)
        XCTAssertEqual(ServerConfiguration.origin.absoluteString, "https://porchday.com")
        XCTAssertEqual(ServerConfiguration.keychainService, "com.porchday.app.keys")
    }
    func testAuthenticatedRedirectsCannotLeaveChosenOrigin() {
        let staging = URL(string: "https://staging.porchday.com")!
        XCTAssertTrue(ServerConfiguration.permits(URL(string: "https://staging.porchday.com/api/v1/me")!, origin: staging))
        for value in ["https://porchday.com/api/v1/me", "http://staging.porchday.com/api/v1/me", "https://staging.porchday.com:444/api/v1/me", "https://user@staging.porchday.com/api/v1/me", "https://staging.porchday.com.evil.example/api/v1/me"] {
            XCTAssertFalse(ServerConfiguration.permits(URL(string: value)!, origin: staging))
        }
    }
}

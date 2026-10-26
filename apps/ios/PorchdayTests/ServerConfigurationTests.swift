import Foundation
import XCTest
@testable import Porchday

final class ServerConfigurationTests: XCTestCase {
    func testNewProductionAddressPreservesTheExistingKeychain() {
        XCTAssertFalse(ServerConfiguration.hostedStagingTestEnabled)
        XCTAssertEqual(ServerConfiguration.origin.absoluteString, "https://porchday.org")
        XCTAssertEqual(ServerConfiguration.keychainService, "com.porchday.app.keys")
    }
    func testAuthenticatedRedirectsCannotLeaveChosenOrigin() {
        let staging = URL(string: "https://staging.porchday.com")!
        XCTAssertTrue(ServerConfiguration.permits(URL(string: "https://staging.porchday.com/api/v1/me")!, origin: staging))
        for value in ["https://porchday.org/api/v1/me", "https://porchday.com/api/v1/me", "http://staging.porchday.com/api/v1/me", "https://staging.porchday.com:444/api/v1/me", "https://user@staging.porchday.com/api/v1/me", "https://staging.porchday.com.evil.example/api/v1/me"] {
            XCTAssertFalse(ServerConfiguration.permits(URL(string: value)!, origin: staging))
        }
    }
    func testSharedPostLinksAcceptBothOwnedDomainsWithoutBroadeningAPITrust() {
        let id = "11111111-1111-4111-8111-111111111111"
        for host in ["porchday.org", "porchday.com"] {
            XCTAssertEqual(ServerConfiguration.postID(from: URL(string: "https://" + host + "/app/post/" + id)!), id)
        }
        XCTAssertFalse(ServerConfiguration.permits(URL(string: "https://porchday.com/api/v1/me")!))
        XCTAssertTrue(ServerConfiguration.permits(URL(string: "https://porchday.org/api/v1/me")!))
        for value in [
            "http://porchday.org/app/post/" + id,
            "https://porchday.org:444/app/post/" + id,
            "https://user@porchday.org/app/post/" + id,
            "https://porchday.org.evil.example/app/post/" + id,
            "https://porchday.com.evil.example/app/post/" + id,
            "https://staging.porchday.com/app/post/" + id,
            "https://porchday.org/app/post/not-a-uuid",
            "https://porchday.org/app/post/" + id + "/extra",
            "https://porchday.org/app/post/" + id + "?token=synthetic",
            "https://porchday.org/app/post/" + id + "#unexpected",
        ] {
            XCTAssertNil(ServerConfiguration.postID(from: URL(string: value)!), value)
        }
    }

}

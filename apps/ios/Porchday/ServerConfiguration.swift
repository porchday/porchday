import Foundation

enum ServerConfiguration {
    // This opt-in changes only the fixed server address in a DEBUG build. It
    // neither supplies a session nor changes any server authentication rule.
    static let hostedStagingTestEnabled: Bool = {
        #if DEBUG
        return ProcessInfo.processInfo.environment["PORCHDAY_HOSTED_STAGING_TEST"] == "1"
        #else
        return false
        #endif
    }()
    static let origin = URL(string: hostedStagingTestEnabled ? "https://staging.porchday.com" : "https://porchday.org")!
    static let keychainService = hostedStagingTestEnabled ? "com.porchday.app.keys.hosted-staging-test" : "com.porchday.app.keys"

    // Keep the existing Keychain service and bundle identity through domain changes.
    // Accept old shared links, while authenticated requests remain on one fixed origin.
    static func postID(from url: URL) -> String? {
        guard url.scheme == "https", ["porchday.org", "porchday.com"].contains(url.host ?? ""),
              url.port == nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else { return nil }
        let path = url.pathComponents
        guard path.count == 4, path[1] == "app", path[2] == "post", UUID(uuidString: path[3]) != nil else { return nil }
        return path[3]
    }

    static func passwordResetRedirect(origin: URL = ServerConfiguration.origin) -> URL {
        origin.appendingPathComponent("reset")
    }

    static func permits(_ url: URL, origin: URL = ServerConfiguration.origin) -> Bool {
        url.scheme == "https" && url.host == origin.host && url.port == origin.port &&
            url.user == nil && url.password == nil && url.fragment == nil
    }
}

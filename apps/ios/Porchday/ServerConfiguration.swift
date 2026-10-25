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
    static let origin = URL(string: hostedStagingTestEnabled ? "https://staging.porchday.com" : "https://porchday.com")!
    static let keychainService = hostedStagingTestEnabled ? "com.porchday.app.keys.hosted-staging-test" : "com.porchday.app.keys"

    static func permits(_ url: URL, origin: URL = ServerConfiguration.origin) -> Bool {
        url.scheme == "https" && url.host == origin.host && url.port == origin.port &&
            url.user == nil && url.password == nil && url.fragment == nil
    }
}

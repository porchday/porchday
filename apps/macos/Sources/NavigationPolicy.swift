import Foundation

enum NavigationPolicy {
    static let home = URL(string: "https://porchday.org/app")!
    static func isInternal(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == "porchday.org" &&
        (url.port == nil || url.port == 443) && url.user == nil && url.password == nil
    }
    static func canOpenExternally(_ url: URL) -> Bool {
        ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") &&
        url.user == nil && url.password == nil
    }
}

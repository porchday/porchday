import Foundation
import OSLog

/// Only these fixed labels may reach Instruments. Never emit a URL, identifier,
/// error description, request body, credential, or response content.
enum NativeRequestOperation: String, Sendable {
    case bootstrap, feed, postRead, postCreate, postEdit, reactionWrite, mediaRead
    case logoutRequest, otherRead, otherWrite

    static func classify(path: String, method: String) -> Self {
        let route = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        let parts = route.split(separator: "/").map(String.init)
        let read = method == "GET"
        if parts == ["api", "auth", "sign-out"], method == "POST" { return .logoutRequest }
        guard parts.count >= 3, parts[0] == "api", parts[1] == "v1" else { return read ? .otherRead : .otherWrite }
        if read, parts == ["api", "v1", "me"], URLComponents(string: path)?.queryItems?.contains(where: { $0.name == "bootstrap" && $0.value == "1" }) == true { return .bootstrap }
        if read, parts == ["api", "v1", "feed"] { return .feed }
        if read, parts.count == 5, parts[2] == "groups", UUID(uuidString: parts[3]) != nil, parts[4] == "feed" { return .feed }
        if parts == ["api", "v1", "posts"], method == "POST" { return .postCreate }
        if parts.count >= 4, UUID(uuidString: parts[3]) != nil {
            if parts[2] == "posts", parts.count == 4 {
                if read { return .postRead }
                if method == "PUT" { return .postEdit }
            }
            if ["posts", "comments"].contains(parts[2]), parts.count == 6, parts[4] == "reactions", ["PUT", "DELETE"].contains(method) { return .reactionWrite }
            if read, parts[2] == "media" { return .mediaRead }
        }
        return read ? .otherRead : .otherWrite
    }
}

enum NativePerformance {
    private static let signposter = OSSignposter(subsystem: "com.porchday.app", category: "Performance")

    static func begin(_ operation: NativeRequestOperation) -> OSSignpostIntervalState {
        signposter.beginInterval("HTTP request", id: signposter.makeSignpostID(), "operation=\(operation.rawValue, privacy: .public)")
    }

    static func end(_ state: OSSignpostIntervalState, status: Int, completed: Bool) {
        signposter.endInterval("HTTP request", state, "status=\(status) completed=\(completed)")
    }
}

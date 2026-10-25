import Foundation

actor API {
    static let shared = API()
    let baseURL = ServerConfiguration.origin
    private let session: URLSession
    private var cookies: [String: String] = [:]
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        session = URLSession(configuration: config, delegate: SameOriginRedirects(origin: ServerConfiguration.origin), delegateQueue: nil)
        if let data = try? SecureStore.read("session"), let loaded = try? JSONDecoder().decode([String: String].self, from: data) { cookies = loaded }
    }
    func request(_ path: String, method: String = "GET", body: JSON? = nil) async throws -> JSON {
        let data = try await bytes(path, method: method, body: body.map { try JSONEncoder().encode($0) }, contentType: "application/json")
        if data.isEmpty { return .object([:]) }; return try JSONDecoder().decode(JSON.self, from: data)
    }
    func bytes(_ path: String, method: String = "GET", body: Data? = nil, contentType: String = "application/octet-stream") async throws -> Data {
        guard path.hasPrefix("/api/"), let url = URL(string: path, relativeTo: baseURL)?.absoluteURL, ServerConfiguration.permits(url, origin: baseURL) else { throw PorchError.message("Untrusted server address.") }
        var req = URLRequest(url: url); req.httpMethod = method; req.httpBody = body
        req.setValue(baseURL.absoluteString, forHTTPHeaderField: "Origin")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if !cookies.isEmpty { req.setValue(cookies.map { "\($0.key)=\($0.value)" }.joined(separator: "; "), forHTTPHeaderField: "Cookie") }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw PorchError.message("No server response. Try again when connected.") }
        let headers = Dictionary(uniqueKeysWithValues: http.allHeaderFields.compactMap { key, value -> (String, String)? in guard let key = key as? String, let value = value as? String else { return nil }; return (key, value) })
        for cookie in HTTPCookie.cookies(withResponseHeaderFields: headers, for: url) {
            if cookie.expiresDate.map({ $0 <= Date() }) == true || cookie.value.isEmpty { cookies.removeValue(forKey: cookie.name) } else { cookies[cookie.name] = cookie.value }
        }
        try SecureStore.write(JSONEncoder().encode(cookies), account: "session")
        guard (200..<300).contains(http.statusCode) else {
            let error = (try? JSONDecoder().decode(JSON.self, from: data)) ?? .null
            let message = error["error"]["message"].string ?? error["message"].string ?? error["error"]["code"].string ?? "This action is unavailable. Please try again."
            throw PorchError.api(code:error["error"]["code"].string ?? error["code"].string ?? "REQUEST_FAILED",message:message.replacingOccurrences(of:"_",with:" "),details:error["error"]["details"])
        }
        return data
    }
    func social(_ path: String, method: String = "GET", body: JSON? = nil) async throws -> JSON { try await request("/api/v1" + path, method: method, body: body) }
    func auth(_ path: String, body: JSON? = nil, method: String = "POST") async throws -> JSON { try await request("/api/auth/" + path, method: method, body: body) }
    func clearSession() { cookies = [:]; SecureStore.delete("session") }
}

private final class SameOriginRedirects:NSObject,URLSessionTaskDelegate,@unchecked Sendable {
    private let origin: URL
    init(origin: URL) { self.origin = origin; super.init() }
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void) {
        completionHandler(request.url.map { ServerConfiguration.permits($0, origin: origin) } == true ? request:nil)
    }
}

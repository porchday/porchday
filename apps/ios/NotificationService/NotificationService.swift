import Foundation
import UserNotifications
import ImageIO

/// Only encrypted notification material is fetched. Always deliver the original
/// generic alert if unavailable; a failed preview must not lose the notification.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?
    private var task: Task<Void, Never>?
    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.lock(); handler = contentHandler; original = request.content; lock.unlock()
        guard let ref = request.content.userInfo["preview"] as? [String: String],
            let token = ref["token"], token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
            let id = ref["keyId"], let key = try? NotificationPreviewKey.read(), key.keyId == id else { finish(); return }
        let source = ImmutableNotification(content: request.content)
        task = Task { @Sendable [weak self] in
            guard let self else { return }
            do {
                // Fixed HTTPS origin, no cookies/session or redirects, bounded response.
                let configuration = URLSessionConfiguration.ephemeral
                configuration.timeoutIntervalForRequest = 7; configuration.timeoutIntervalForResource = 10
                configuration.httpShouldSetCookies = false; configuration.urlCache = nil
                let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
                defer { session.invalidateAndCancel() }
                var request = URLRequest(url: URL(string: "https://porchday.org/api/notification-preview")!)
                request.httpMethod = "POST"; request.setValue("https://porchday.org", forHTTPHeaderField: "Origin"); request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["token": token])
                let (stream, response) = try await session.bytes(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw NotificationPreviewCrypto.Failure.invalid }
                var data = Data()
                for try await byte in stream { if data.count >= 1_000_000 { throw NotificationPreviewCrypto.Failure.invalid }; data.append(byte) }
                let preview = try NotificationPreviewCrypto.decrypt(data, key: key)
                guard !Task.isCancelled, (try NotificationPreviewKey.read())?.keyId == id,
                    let content = source.content.mutableCopy() as? UNMutableNotificationContent else { throw NotificationPreviewCrypto.Failure.invalid }
                let actor = source.content.userInfo["actor"] as? String
                let author = actor.flatMap { $0.range(of: "^[a-zA-Z0-9_]{1,40}$", options: .regularExpression) != nil ? "@" + $0 : nil }
                if !preview.text.isEmpty { content.body = (author.map { $0 + ": " } ?? "") + preview.text }
                content.userInfo["previewPath"] = preview.path
                if let image = preview.image, let attachment = try? Self.attachment(image) { content.attachments = [attachment] }
                finish(content)
            } catch { finish() }
        }
    }
    override func serviceExtensionTimeWillExpire() { task?.cancel(); finish() }
    private func finish(_ content: UNNotificationContent? = nil) {
        lock.lock(); let callback = handler; handler = nil; let fallback = original; original = nil; lock.unlock()
        if let callback, let result = content ?? fallback { callback(result) }
    }
    private static func attachment(_ image: Data) throws -> UNNotificationAttachment {
        guard image.count <= 18000, let source = CGImageSourceCreateWithData(image as CFData, nil),
            CGImageSourceGetType(source) as String? == "public.jpeg",
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
            let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
            let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
            width > 0, height > 0, width <= 320, height <= 320 else { throw NotificationPreviewCrypto.Failure.invalid }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("preview.jpg")
        try image.write(to: url, options: .atomic)
        // The notification system moves the attachment into its own storage.
        defer { try? FileManager.default.removeItem(at: directory) }
        return try UNNotificationAttachment(identifier: "photo", url: url)
    }
}
private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

// UNNotificationContent is immutable; only the task-local mutable copy is edited.
private struct ImmutableNotification: @unchecked Sendable { let content: UNNotificationContent }

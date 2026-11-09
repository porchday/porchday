import Foundation
import UserNotifications
import ImageIO

enum NotificationPreviewAttachment {
    static func create(_ image: Data) throws -> UNNotificationAttachment {
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
        // Apple validates and moves the file only AFTER the service finishes.
        // Keep a successful attachment alive for that handoff; tmp is OS-managed.
        do { return try UNNotificationAttachment(identifier: "photo", url: url) }
        catch { try? FileManager.default.removeItem(at: directory); throw error }
    }
}

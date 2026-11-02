import SwiftUI
import ImageIO
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
typealias PlatformImage = UIImage
#else
import AppKit
typealias PlatformImage = NSImage
extension NSImage {
    convenience init(cgImage: CGImage) { self.init(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height)) }
}
#endif
extension Image {
    init(platformImage: PlatformImage) {
        #if os(iOS)
        self.init(uiImage: platformImage)
        #else
        self.init(nsImage: platformImage)
        #endif
    }
}
enum PorchKeyboard { case `default`, emailAddress, numberPad }
enum PorchCapitalization { case never, characters }
enum PorchContentType { case emailAddress, newPassword, password, oneTimeCode, none }
extension View {
    @ViewBuilder func porchInlineTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }
    @ViewBuilder func porchKeyboard(_ kind: PorchKeyboard) -> some View {
        #if os(iOS)
        keyboardType(kind == .emailAddress ? .emailAddress : kind == .numberPad ? .numberPad : .default)
        #else
        self
        #endif
    }
    @ViewBuilder func porchCapitalization(_ kind: PorchCapitalization) -> some View {
        #if os(iOS)
        textInputAutocapitalization(kind == .never ? .never : .characters)
        #else
        self
        #endif
    }
    @ViewBuilder func porchContentType(_ kind: PorchContentType) -> some View {
        #if os(iOS)
        textContentType(kind == .emailAddress ? .emailAddress : kind == .newPassword ? .newPassword : kind == .password ? .password : kind == .oneTimeCode ? .oneTimeCode : nil)
        #else
        self
        #endif
    }
}
@MainActor enum ApplePlatform {
    static var cameraAvailable: Bool {
        #if os(iOS)
        UIImagePickerController.isSourceTypeAvailable(.camera)
        #else
        false
        #endif
    }
    static func registerPush() {
        #if os(iOS)
        UIApplication.shared.registerForRemoteNotifications()
        #else
        NSApplication.shared.registerForRemoteNotifications()
        #endif
    }
    static func unregisterPush() {
        #if os(iOS)
        UIApplication.shared.unregisterForRemoteNotifications()
        #else
        NSApplication.shared.unregisterForRemoteNotifications()
        #endif
    }
}
/// Re-encode only newly selected media; received encrypted bytes keep their identity.
enum AppleImageEncoder {
    static func encode(_ image: CGImage, jpeg: Bool) throws -> Data {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, (jpeg ? UTType.jpeg.identifier : UTType.png.identifier) as CFString, 1, nil) else { throw PorchError.message("Image encoding is unavailable.") }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.86] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw PorchError.message("Could not encode image.") }
        return output as Data
    }
    static func rgba(_ image: CGImage) throws -> CGImage {
        guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw PorchError.message("Could not prepare image.") }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let result = context.makeImage() else { throw PorchError.message("Could not prepare image.") }; return result
    }
    static func opaque(_ image: CGImage) throws -> CGImage {
        guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw PorchError.message("Could not prepare image.") }
        context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let result = context.makeImage() else { throw PorchError.message("Could not prepare image.") }; return result
    }
}

enum SecureTemporaryFiles {
    static func protect(_ url: URL, directory: Bool = false) throws {
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: directory ? 0o700 : 0o600]
        #if os(iOS)
        attributes[.protectionKey] = FileProtectionType.complete
        #endif
        try FileManager.default.setAttributes(attributes, ofItemAtPath: url.path)
    }
    static var writeOptions: Data.WritingOptions {
        #if os(iOS)
        [.atomic, .completeFileProtection]
        #else
        [.atomic]
        #endif
    }
}

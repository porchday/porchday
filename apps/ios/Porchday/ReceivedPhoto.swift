import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Checks untrusted decrypted bytes before allocating decoded image pixels.
enum ReceivedPhoto {
    static func decodeJPEG(_ data: Data) throws -> (image: CGImage, orientation: UInt32) {
        let failure = PorchError.message("This photo is not a complete JPEG within safe image limits.")
        // ImageIO can report a recoverable JPEG as complete without its final
        // marker. The supported wire format requires the full JPEG framing.
        guard data.count >= 4, data.count <= 20 * 1024 * 1024,
              data.prefix(2).elementsEqual([0xff, 0xd8]),
              data.suffix(2).elementsEqual([0xff, 0xd9]),
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetType(source) as String? == UTType.jpeg.identifier,
              CGImageSourceGetCount(source) == 1,
              CGImageSourceGetStatus(source) == .statusComplete,
              CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 2400, height <= 2400 else { throw failure }
        guard let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
              image.width == width, image.height == height else { throw failure }
        let orientation = properties[kCGImagePropertyOrientation] as? UInt32 ?? 1
        guard (1...8).contains(orientation) else { throw failure }
        return (image, orientation)
    }
}

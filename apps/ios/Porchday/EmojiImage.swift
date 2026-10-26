import UIKit
import ImageIO

@MainActor enum EmojiImage {
    static func prepare(_ data: Data) throws -> Data {
        guard data.count <= 5 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache:false] as CFDictionary), CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 40000, height <= 40000, width * height <= 16_000_000 else { throw PorchError.message("Choose a still image no larger than 5 MB and 16 megapixels.") }
        for maximum in [128,96,64,48] {
            let options: [CFString:Any] = [kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,kCGImageSourceThumbnailMaxPixelSize:maximum,kCGImageSourceShouldCacheImmediately:true]
            guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source,0,options as CFDictionary) else { throw PorchError.message("The image could not be opened.") }
            let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = false; format.preferredRange = .standard
            let size = CGSize(width:CGFloat(thumbnail.width),height:CGFloat(thumbnail.height))
            let image = UIGraphicsImageRenderer(size:size,format:format).image { _ in UIImage(cgImage:thumbnail).draw(in:CGRect(origin:.zero,size:size)) }
            guard let encoded = image.pngData() else { throw PorchError.message("The image could not be prepared.") }
            let clean = try stripMetadata(encoded)
            if clean.count <= ReactionPNG.maximumBytes { _ = try ReactionPNG.decode(clean); return clean }
        }
        throw PorchError.message("Choose a simpler image that fits within 32 KB.")
    }
    /// Used only on newly encoded own uploads. A received emoji is validated
    /// and reused byte-for-byte, never normalized into a different identity.
    static func stripMetadata(_ data: Data) throws -> Data {
        let bytes = [UInt8](data)
        guard bytes.count >= 8, Array(bytes.prefix(8)) == ReactionPNG.signature else { throw PorchError.message("Invalid PNG encoding.") }
        var output = Data(bytes.prefix(8)), offset = 8
        while offset < bytes.count {
            guard bytes.count - offset >= 12 else { throw PorchError.message("Invalid PNG encoding.") }
            let size = Int(bytes[offset..<offset+4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }), end = offset + size + 12
            guard end <= bytes.count, let kind = String(bytes:bytes[offset+4..<offset+8],encoding:.ascii) else { throw PorchError.message("Invalid PNG encoding.") }
            if ["IHDR","PLTE","tRNS","IDAT","IEND"].contains(kind) { output.append(contentsOf:bytes[offset..<end]) }
            offset = end
        }
        return output
    }
}

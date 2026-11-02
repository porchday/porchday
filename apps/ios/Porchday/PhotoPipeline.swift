import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif
import ImageIO

@MainActor enum PhotoPipeline {
    static func prepare(_ data: Data) throws -> PreparedPhoto {
        guard data.count <= 50 * 1024 * 1024, let source = CGImageSourceCreateWithData(data as CFData, nil), let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any], let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0, width <= 40000, height <= 40000 else { throw PorchError.message("Choose a readable photo that is 50 MB or smaller.") }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2400, kCGImageSourceShouldCacheImmediately: true]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw PorchError.message("This photo could not be decoded safely.") }
        let bytes = try AppleImageEncoder.encode(AppleImageEncoder.opaque(thumbnail), jpeg: true)
        return PreparedPhoto(bytes: bytes, width: thumbnail.width, height: thumbnail.height)
    }
    static func safelyDecode(_ data: Data) throws -> PlatformImage {
        let decoded = try ReceivedPhoto.decodeJPEG(data)
        #if os(iOS)
        let orientations: [UIImage.Orientation] = [.up, .upMirrored, .down, .downMirrored, .leftMirrored, .right, .rightMirrored, .left]
        return UIImage(cgImage: decoded.image, scale: 1, orientation: orientations[Int(decoded.orientation) - 1])
        #else
        guard let image = NSImage(data: data) else { throw PorchError.message("Could not decode validated photo.") }
        return image
        #endif
    }
}
struct EncryptedPhotoView: View {
    let photo: JSON
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var image: PlatformImage?
    @State private var expiry: Date?
    @State private var error = ""
    var body: some View {
        TimelineView(.periodic(from:.now,by:1)) { clock in
            let expired=expiry.map{$0<=clock.date} ?? false
            VStack(alignment:.leading) {
                if expired { Label("This photo has expired.",systemImage:"timer").font(.caption) }
                else if let image {
                    Image(platformImage:image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius:12)).accessibilityLabel(photo["alt"].string ?? "Shared photo")
                    if let alt=photo["alt"].string,!alt.isEmpty { Text(alt).font(.caption).foregroundStyle(.secondary) }
                } else { Label(error.isEmpty ? "Opening encrypted photo…":error,systemImage:"photo").font(.caption).padding() }
            }.onChange(of:expired) { _,value in if value { image=nil } }
        }.task(id:photo["id"].string) {
            image=nil;expiry=nil;error=""
            do {
                guard let id=photo["id"].string else { return }
                let bytes=try await model.api.bytes("/api/v1/media/\(id)/bytes"),envelope=try JSONDecoder().decode(JSON.self,from:bytes)
                let payload=try await vault.open(.object(["id":.string(id),"envelope":envelope]))
                guard payload["mime"].string=="image/jpeg",let encoded=payload["bytes"].string,let imageData=Data(base64Encoded:encoded) else { throw PorchError.message("Unsupported encrypted photo format.") }
                expiry=envelope["context"]["expiresAt"].string.flatMap(PorchDate.parse)
                image=try PhotoPipeline.safelyDecode(imageData)
            } catch { self.error=error.localizedDescription }
        }
    }
}
#if os(iOS)
struct CameraView: UIViewControllerRepresentable {
    let captured: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss
    func makeUIViewController(context: Context) -> UIImagePickerController { let picker = UIImagePickerController(); picker.sourceType = .camera; picker.delegate = context.coordinator; return picker }
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let parent: CameraView
        init(_ parent: CameraView) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) { if let image = info[.originalImage] as? UIImage { parent.captured(image) }; parent.dismiss() }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

#else
struct CameraView: View { let captured: (PlatformImage) -> Void; var body: some View { Text("Choose a photo from your library or files.") } }
#endif

import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif
import ImageIO
import CryptoKit

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
/// Serial decoding bounds transient pixel allocations without blocking SwiftUI.
private actor NativeJPEGDecoder {
    static let shared = NativeJPEGDecoder()
    func decode(_ data: Data) throws -> (image: CGImage, orientation: UInt32) {
        try Task.checkCancellation()
        let result = try ReceivedPhoto.decodeJPEG(data)
        try Task.checkCancellation(); return result
    }
}

/// Decode each verified JPEG once within a short foreground window. Byte-keyed
/// entries cannot substitute an old image for changed signed content.
@MainActor final class NativeImageCache {
    private var entries = NativeMemoryCache<PlatformImage>(budget: 64 * 1024 * 1024, limit: 32)
    private var generation = 0
    private var pending: [String: (id: UUID, task: Task<(image: CGImage, orientation: UInt32), Error>)] = [:]
    func clear() {
        generation += 1; entries.clear()
        for work in pending.values { work.task.cancel() }; pending.removeAll()
    }
    func decode(_ data: Data, expiry: Date? = nil) async throws -> PlatformImage {
        try Task.checkCancellation()
        guard expiry.map({ $0 > Date() }) ?? true else { throw PorchError.message("This photo has expired.") }
        let key = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        if let image = entries.value(for: key) { return image }
        let epoch = generation
        let work: (id: UUID, task: Task<(image: CGImage, orientation: UInt32), Error>)
        if let existing = pending[key] { work = existing }
        else {
            work = (UUID(), Task { try await NativeJPEGDecoder.shared.decode(data) })
            pending[key] = work
        }
        do {
            let decoded = try await work.task.value
            guard epoch == generation, !work.task.isCancelled, expiry.map({ $0 > Date() }) ?? true else { throw CancellationError() }
            try Task.checkCancellation()
            if pending[key]?.id == work.id { pending[key] = nil }
            if let existing = entries.value(for: key) { return existing }
            #if os(iOS)
            let orientations: [UIImage.Orientation] = [.up, .upMirrored, .down, .downMirrored, .leftMirrored, .right, .rightMirrored, .left]
            let image = UIImage(cgImage: decoded.image, scale: 1, orientation: orientations[Int(decoded.orientation) - 1])
            #else
            guard let image = NSImage(data: data) else { throw PorchError.message("Could not decode validated photo.") }
            #endif
            entries.insert(image, for: key, cost: decoded.image.width * decoded.image.height * 4, expires: min(expiry ?? .distantFuture, Date().addingTimeInterval(20)))
            return image
        } catch {
            if pending[key]?.id == work.id { pending[key] = nil }
            throw error
        }
    }
}
struct EncryptedPhotoView: View {
    let photo: JSON
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @State private var image: PlatformImage?
    @State private var expiry: Date?
    @State private var loadedID: String?
    @State private var error = ""
    var body: some View {
        TimelineView(.explicit([expiry].compactMap { $0 })) { clock in
            let expired=expiry.map{$0<=clock.date} ?? false
            VStack(alignment:.leading) {
                if expired { Label("This photo has expired.",systemImage:"timer").font(.caption) }
                else if let image {
                    ViewablePhoto(image: image, caption: photo["alt"].string ?? "", expiresAt: expiry).clipShape(RoundedRectangle(cornerRadius:12))
                    ForEach(NativePhotoContract.captions(photo), id: \.self) { Text($0).font(.caption) }; PeopleTagsView(tags: PersonTag.parse(photo["tags"]))
                } else { Label(error.isEmpty ? "Opening encrypted photo…":error,systemImage:"photo").font(.caption).padding() }
            }.onChange(of:expired) { _,value in if value { image=nil } }
        }.task(id: (photo["id"].string ?? "") + ":\(model.foregroundVersion)") {
            error=""
            let generation = model.authenticationGeneration
            do {
                guard let id=photo["id"].string else { return }
                if loadedID != id { image = nil; expiry = nil }
                let envelope=try await model.api.social("/media/\(id)/bytes")
                let payload=try await vault.open(.object(["id":.string(id),"envelope":envelope]))
                guard payload["mime"].string=="image/jpeg",let encoded=payload["bytes"].string,let imageData=Data(base64Encoded:encoded) else { throw PorchError.message("Unsupported encrypted photo format.") }
                expiry=envelope["context"]["expiresAt"].string.flatMap(PorchDate.parse)
                try Task.checkCancellation()
                guard generation == model.authenticationGeneration, vault.unlocked else { return }
                let decoded = try await vault.images.decode(imageData, expiry: expiry)
                guard generation == model.authenticationGeneration, vault.unlocked, !Task.isCancelled else { return }
                image = decoded; loadedID = id
            } catch { if !(error is CancellationError) && !Task.isCancelled { image = nil; self.error=error.localizedDescription } }
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

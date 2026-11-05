import SwiftUI

struct ViewablePhoto: View {
    let image: PlatformImage
    let caption: String
    var expiresAt: Date? = nil
    @State private var showing = false
    var body: some View {
        Button { showing = true } label: {
            Image(platformImage: image).resizable().scaledToFit()
        }.buttonStyle(.plain).accessibilityLabel("Open photo: " + (caption.isEmpty ? "Shared photo" : caption))
        .sheet(isPresented: $showing) { NativePhotoViewer(image: image, caption: caption, expiresAt: expiresAt) }
    }
}
struct NativePhotoViewer: View {
    let image: PlatformImage
    let caption: String
    let expiresAt: Date?
    @Environment(\.dismiss) private var dismiss
    @State private var zoom: CGFloat = 1
    @State private var offset = CGSize.zero
    @GestureState private var magnification: CGFloat = 1
    @GestureState private var drag = CGSize.zero
    private func reset() { zoom = 1; offset = .zero }
    private var effectiveZoom: CGFloat { min(6, max(1, zoom * magnification)) }
    private var effectiveOffset: CGSize { zoom > 1 ? CGSize(width: offset.width + drag.width, height: offset.height + drag.height) : .zero }
    private func changeZoom(_ amount: CGFloat) { zoom = min(6, max(1, zoom + amount)); if zoom == 1 { offset = .zero } }
    private var toolbar: some View {
        HStack {
            Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.accessibilityLabel("Close photo viewer").keyboardShortcut(.cancelAction)
            Spacer()
            Button { changeZoom(-0.5) } label: { Image(systemName: "minus").frame(width: 44, height: 44) }.accessibilityLabel("Zoom out").disabled(zoom <= 1)
            Button("\(Int(zoom * 100))%") { reset() }.accessibilityLabel("Reset photo zoom")
            Button { changeZoom(0.5) } label: { Image(systemName: "plus").frame(width: 44, height: 44) }.accessibilityLabel("Zoom in").disabled(zoom >= 6)
        }.padding(.horizontal)
    }
    private var zoomGesture: some Gesture {
        MagnifyGesture().updating($magnification) { value, state, _ in state = value.magnification }
            .onEnded { value in zoom = min(6, max(1, zoom * value.magnification)); if zoom == 1 { offset = .zero } }
    }
    private func panGesture(_ size: CGSize) -> some Gesture {
        DragGesture().updating($drag) { value, state, _ in if zoom > 1 { state = value.translation } }
            .onEnded { value in
                guard zoom > 1 else { return }
                let maxX = size.width * (zoom - 1) / 2
                let maxY = size.height * (zoom - 1) / 2
                let x = max(-maxX, min(maxX, offset.width + value.translation.width))
                let y = max(-maxY, min(maxY, offset.height + value.translation.height))
                offset = CGSize(width: x, height: y)
            }
    }
    private func photoCanvas(_ size: CGSize) -> some View {
        Image(platformImage: image).resizable().scaledToFit()
            .frame(width: size.width, height: size.height)
            .scaleEffect(effectiveZoom).offset(effectiveOffset)
            .contentShape(Rectangle()).gesture(zoomGesture).simultaneousGesture(panGesture(size))
            .onTapGesture(count: 2) { if zoom > 1 { reset() } else { zoom = 2 } }
            .accessibilityLabel(caption.isEmpty ? "Shared photo" : caption)
    }
    var body: some View {
        VStack(spacing: 0) {
            toolbar
            GeometryReader { geometry in photoCanvas(geometry.size) }.clipped()
            if !caption.isEmpty { ScrollView { Text(caption).font(.callout).frame(maxWidth: .infinity, alignment: .leading).padding() }.frame(maxHeight: 100) }
        }.background(Color(red: 0.09, green: 0.085, blue: 0.07)).foregroundStyle(.white)
        .frame(minWidth: 300, minHeight: 400)
        .task { if let expiresAt { try? await Task.sleep(for: .seconds(max(0, expiresAt.timeIntervalSinceNow))); if !Task.isCancelled { dismiss() } } }
    }
}

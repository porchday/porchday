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
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.accessibilityLabel("Close photo viewer").keyboardShortcut(.cancelAction)
                Spacer()
                Button { zoom = max(1, zoom - 0.5); if zoom == 1 { offset = .zero } } label: { Image(systemName: "minus").frame(width: 44, height: 44) }.accessibilityLabel("Zoom out").disabled(zoom <= 1)
                Button("\(Int(zoom * 100))%") { reset() }.accessibilityLabel("Reset photo zoom")
                Button { zoom = min(6, zoom + 0.5) } label: { Image(systemName: "plus").frame(width: 44, height: 44) }.accessibilityLabel("Zoom in").disabled(zoom >= 6)
            }.padding(.horizontal)
            GeometryReader { geometry in
                Image(platformImage: image).resizable().scaledToFit()
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .scaleEffect(min(6, max(1, zoom * magnification)))
                    .offset(zoom > 1 ? CGSize(width: offset.width + drag.width, height: offset.height + drag.height) : .zero)
                    .contentShape(Rectangle())
                    .gesture(MagnifyGesture().updating($magnification) { value, state, _ in state = value.magnification }.onEnded { value in zoom = min(6, max(1, zoom * value.magnification)); if zoom == 1 { offset = .zero } })
                    .simultaneousGesture(DragGesture().updating($drag) { value, state, _ in if zoom > 1 { state = value.translation } }.onEnded { value in
                        if zoom > 1 { offset = CGSize(width: max(-geometry.size.width * (zoom-1)/2, min(geometry.size.width * (zoom-1)/2, offset.width + value.translation.width)), height: max(-geometry.size.height * (zoom-1)/2, min(geometry.size.height * (zoom-1)/2, offset.height + value.translation.height))) }
                    })
                    .onTapGesture(count: 2) { if zoom > 1 { reset() } else { zoom = 2 } }
                    .accessibilityLabel(caption.isEmpty ? "Shared photo" : caption)
            }.clipped()
            if !caption.isEmpty { ScrollView { Text(caption).font(.callout).frame(maxWidth: .infinity, alignment: .leading).padding() }.frame(maxHeight: 100) }
        }.background(Color(red: 0.09, green: 0.085, blue: 0.07)).foregroundStyle(.white)
        .frame(minWidth: 300, minHeight: 400)
        .task { if let expiresAt { try? await Task.sleep(for: .seconds(max(0, expiresAt.timeIntervalSinceNow))); if !Task.isCancelled { dismiss() } } }
    }
}

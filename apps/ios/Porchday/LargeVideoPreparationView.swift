import SwiftUI
import AVKit
struct LargeVideoPreparationView: View {
    let source:SelectedVideoFile
    let prepared:(PreparedPhoto)->Void
    @Environment(\.dismiss) private var dismiss
    @State private var resolution=1080
    @State private var duration=0.0
    @State private var busy=false
    @State private var error=""
    @State private var operation:Task<Void,Never>?
    var body: some View {
        NavigationStack { Form {
            Text("Your video is prepared on this device, then encrypted before upload. The full video is kept without cropping or trimming. Videos can be up to 10 minutes; the prepared copy must fit within 250 MiB.")
            Picker("Quality",selection:$resolution) { Text("1080p").tag(1080);Text("720p · smaller upload").tag(720) }
            Text("Full video: \(duration,specifier:"%.1f") seconds")
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            if busy { ProgressView("Preparing video…") }
            Button("Prepare video") { operation=Task { busy=true;error="";defer{busy=false};do { let photo=try await LargeVideoPreparation.prepare(source,resolution:resolution);try Task.checkCancellation();prepared(photo);dismiss() } catch { if !Task.isCancelled { self.error=error.localizedDescription } } } }.disabled(busy||duration<=0||duration>600)
        }.navigationTitle("Prepare video").toolbar { Button("Cancel") { operation?.cancel();dismiss() } }
        }.task { do { duration=try await LargeVideoPreparation.inspect(source);if duration>600 { throw PorchError.message("Choose a video no longer than 10 minutes. The full video is kept without trimming.") } } catch { self.error=error.localizedDescription } }
        .onDisappear { operation?.cancel() }
    }
}

struct PreparedLargeVideoPreview: View {
    let video:PreparedLargeNativeVideo
    @State private var player:AVPlayer?
    var body:some View { VideoPlayer(player:player).frame(minHeight:180,maxHeight:300)
        .task(id:video.url) { player=AVPlayer(url:video.url) }
        .onDisappear { player?.pause();player?.replaceCurrentItem(with:nil);player=nil }
    }
}

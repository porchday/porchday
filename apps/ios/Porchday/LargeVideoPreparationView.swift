import SwiftUI
struct LargeVideoPreparationView: View {
    let source:SelectedVideoFile
    let prepared:(PreparedPhoto)->Void
    @Environment(\.dismiss) private var dismiss
    @State private var resolution=1080
    @State private var start=0.0
    @State private var end=0.0
    @State private var duration=0.0
    @State private var busy=false
    @State private var error=""
    @State private var operation:Task<Void,Never>?
    var body: some View {
        NavigationStack { Form {
            Text("Your video is prepared on this device, then encrypted before upload. Select up to 10 minutes; the prepared copy must fit within 250 MiB.")
            Picker("Quality",selection:$resolution) { Text("1080p").tag(1080);Text("720p · smaller upload").tag(720) }
            TextField("Start (seconds)",value:$start,format:.number)
            TextField("End (seconds)",value:$end,format:.number)
            Text("Selected: \(max(0,end-start),specifier:"%.1f") seconds")
            if !error.isEmpty { Text(error).foregroundStyle(.red) }
            if busy { ProgressView("Preparing video…") }
            Button("Prepare video") { operation=Task { busy=true;error="";defer{busy=false};do { let photo=try await LargeVideoPreparation.prepare(source,resolution:resolution,start:start,end:end);try Task.checkCancellation();prepared(photo);dismiss() } catch { if !Task.isCancelled { self.error=error.localizedDescription } } } }.disabled(busy||duration<=0)
        }.navigationTitle("Prepare video").toolbar { Button("Cancel") { operation?.cancel();dismiss() } }
        }.task { do { duration=try await LargeVideoPreparation.inspect(source);end=min(600,duration) } catch { self.error=error.localizedDescription } }
        .onDisappear { operation?.cancel() }
    }
}

import AppKit
import UniformTypeIdentifiers

@MainActor final class ShareViewController: NSViewController {
    private let status = NSTextField(wrappingLabelWithString: "Add these photos and videos to Porchday?")
    private let save = NSButton(title: "Add to Porchday", target: nil, action: nil)
    private var task: Task<Void, Never>?
    override func loadView() {
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelShare))
        save.target = self; save.action = #selector(saveShare)
        let stack = NSStackView(views: [status, save, cancel]); stack.orientation = .vertical; stack.spacing = 16
        stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        view = stack; preferredContentSize = NSSize(width: 380, height: 190)
    }
    @objc private func cancelShare() { task?.cancel(); extensionContext?.cancelRequest(withError: CocoaError(.userCancelled)) }
    @objc private func saveShare() {
        guard task == nil else { return }
        save.isEnabled = false; status.stringValue = "Preparing files…"
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        task = Task {
            var directory: URL?
            do {
                guard !providers.isEmpty, providers.count <= 10 else { throw CocoaError(.fileReadTooLarge) }
                let root = try SharedMediaInbox.root()
                _ = try SharedMediaInbox.batches() // Expire old, unfinished handoffs.
                guard (try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)).count < 10 else { throw CocoaError(.fileWriteOutOfSpace) }
                let id = UUID().uuidString.lowercased(), folder = root.appendingPathComponent(id)
                directory = folder
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                var items: [SharedMediaInbox.Item] = [], total = 0
                for provider in providers {
                    try Task.checkCancellation()
                    guard let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true || UTType($0)?.conforms(to: .movie) == true }) else { throw CocoaError(.fileReadUnsupportedScheme) }
                    let item = try await copy(provider, type: type, into: folder)
                    items.append(item); total += item.size
                    guard total <= SharedMediaInbox.maximumBatchBytes else { throw CocoaError(.fileReadTooLarge) }
                    status.stringValue = "Preparing \(items.count) of \(providers.count)…"
                }
                try Task.checkCancellation()
                let batch = SharedMediaInbox.Batch(id: id, created: Date(), items: items)
                try JSONEncoder().encode(batch).write(to: folder.appendingPathComponent("manifest.json"), options: .atomic)
                directory = nil
                status.stringValue = "Ready. Open Porchday → Share to choose your audience and publish. Nothing has been uploaded yet."
                save.title = "Done"; save.action = #selector(finishShare); save.isEnabled = true
            } catch {
                if let directory { try? FileManager.default.removeItem(at: directory) }
                status.stringValue = "Couldn’t add these files. Choose up to 10 photos/videos (photos up to 50 MB, videos up to 1 GiB; 2 GiB total) and try again."
                save.isEnabled = true; task = nil
            }
        }
    }
    @objc private func finishShare() { extensionContext?.completeRequest(returningItems: [], completionHandler: nil) }
    private func copy(_ provider: NSItemProvider, type: String, into folder: URL) async throws -> SharedMediaInbox.Item {
        let name = provider.suggestedName
        return try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                do {
                    guard let url else { throw error ?? CocoaError(.fileNoSuchFile) }
                    continuation.resume(returning: try SharedMediaInbox.copyMedia(url, type: type, suggestedName: name, into: folder))
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
}

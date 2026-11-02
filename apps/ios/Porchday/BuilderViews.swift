import SwiftUI

struct BuilderChatView: View {
    var features = false
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var phase
    @State private var state: JSON?
    @State private var board: [JSON] = []
    @State private var cursor: String?
    @State private var text = ""
    @State private var agreed = false
    @State private var busy = false
    @State private var error = ""
    @State private var export: URL?
    private var pending: Bool { state?["messages"].array.contains { ["queued", "working"].contains($0["status"].string ?? "") } ?? false }
    var body: some View {
        List {
            if let state {
                if !state["disclosure"]["accepted"].boolean {
                    Section("Before you start") {
                        Text("Your messages go to an AI coding agent (OpenAI Codex) that builds Porchday, running on a computer operated by a Porchday maintainer.")
                        Text("Porchday’s operators can read everything you send and everything Codex replies. Builder chat is not encrypted on your device the way your posts are.")
                        Text("Feature suggestions become plans shared with builder-chat participants in Feature additions, alongside your handle. Each person can vote +1 or −1. A net score of +3 queues implementation; voting closes when it is queued. Bug fixes can still be handled directly. Changes can reach every member within about an hour.")
                        Text("Don’t share passwords, recovery codes, private posts or anything about another person.")
                        Text("Your messages are kept for 90 days and are deleted when you delete your account.")
                        Toggle("I understand how builder chat works", isOn: $agreed)
                        Button("Continue") { Task { await write("/builder-chat/disclosure", body: .object(["version": state["disclosure"]["version"]])) } }.disabled(!agreed || busy || state["disclosure"]["version"].integer != 2)
                        if state["disclosure"]["version"].integer != 2 { Text("This build needs an updated disclosure before you can continue.") }
                    }
                } else {
                    Section {
                        Text(state["paused"].boolean ? "Builder chat is paused." : state["online"].boolean ? "Codex is online." : "Codex is offline; queued messages wait for its return.")
                        if pending { Text("A request is queued or working. \(state["ahead"].integer ?? 0) requests ahead. Completion time varies.") }
                        TextEditor(text: $text).frame(minHeight: 100).accessibilityLabel(features ? "Suggest a feature" : "Message the builder")
                        Text(features ? "The resulting plan and your handle are shared with builder-chat participants." : "Builder messages are readable by operators. Never include private content.").font(.caption)
                        Button(features ? "Generate a plan" : "Send message") { Task {
                            let draft = text
                            if await write(features ? "/builder-chat/features" : "/builder-chat/messages", body: .object(["message": .string(draft)])) { if text == draft { text = "" } }
                        } }.disabled(busy || pending || state["paused"].boolean || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > (state["limits"]["message_length"].integer ?? 2000) || (state["sent_today"].integer ?? 0) >= (state["limits"]["daily_messages"].integer ?? 0))
                    }
                    if features {
                        ForEach(Array(board.enumerated()), id: \.offset) { _, feature in
                            Section(feature["title"].string ?? "Feature plan") {
                                Text(feature["plan"].string ?? "").textSelection(.enabled)
                                Text("\(feature["status"].string ?? "") · Net votes: \(feature["score"].integer ?? 0) / +3")
                                if feature["status"].string == "voting", let id = feature["id"].string {
                                    HStack { vote("Support +1", id: id, value: 1); vote("Against −1", id: id, value: -1); vote("Remove vote", id: id, value: 0) }.disabled(busy || state["paused"].boolean)
                                }
                            }
                        }
                        if cursor != nil { Button("Load more plans") { Task { await refresh(more: true) } }.disabled(busy) }
                    } else {
                        ForEach(Array(state["messages"].array.enumerated()), id: \.offset) { _, message in
                            Section(message["created_at"].string ?? "Message") {
                                Text(message["body"].string ?? "").textSelection(.enabled)
                                Text(message["status"].string ?? "").font(.caption)
                                if let progress = message["progress"].string { Text(progress).font(.caption) }
                                Text(message["reply"].string ?? "").textSelection(.enabled)
                            }
                        }
                        Button("Export my builder chat") { Task { await model.perform {
                            let result = try await model.api.social("/builder-chat/export")
                            let url = FileManager.default.temporaryDirectory.appendingPathComponent("porchday-builder-" + UUID().uuidString + ".json")
                            try JSONEncoder().encode(result).write(to: url, options: SecureTemporaryFiles.writeOptions); try SecureTemporaryFiles.protect(url); export = url
                        } } }
                        if let export { ShareLink("Save chat export", item: export) }
                    }
                }
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red); Button("Retry") { Task { await refresh() } } }
            if state == nil && error.isEmpty { ProgressView() }
        }.navigationTitle(features ? "Feature additions" : "Builder chat")
        .task {
            await refresh()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                if phase == .active && !busy && board.count <= 30 { await refresh() }
            }
        }.onDisappear { if let export { try? FileManager.default.removeItem(at: export); self.export = nil } }
    }
    private func vote(_ label: String, id: String, value: Int) -> some View { Button(label) { Task { await write("/builder-chat/features/" + id + "/vote", body: .object(["value": .number(Double(value))]), method: "PUT") } } }
    @discardableResult private func write(_ path: String, body: JSON, method: String = "POST") async -> Bool {
        busy = true; defer { busy = false }; error = ""
        do { _ = try await model.api.social(path, method: method, body: body); await refresh(); return true }
        catch { self.error = error.localizedDescription; return false }
    }
    private func refresh(more: Bool = false) async {
        let generation = model.authenticationGeneration
        do {
            let result = try await model.api.social("/builder-chat")
            var page: JSON = .null
            if features && result["disclosure"]["accepted"].boolean {
                var query = URLComponents(); query.queryItems = more ? [URLQueryItem(name: "cursor", value: cursor)] : []
                page = try await model.api.social("/builder-chat/features" + (more ? "?" + (query.percentEncodedQuery ?? "") : ""))
            }
            guard generation == model.authenticationGeneration, !Task.isCancelled else { return }
            state = result; error = ""
            if features { board = (more ? board : []) + page["items"].array; cursor = page["next_cursor"].string }
        } catch { self.error = error.localizedDescription }
    }
}

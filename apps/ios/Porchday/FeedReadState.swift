import SwiftUI
import UserNotifications
#if os(macOS)
import AppKit
#endif

struct FeedReadItem: Hashable, Sendable {
    let kind: String
    let id: String
    var json: JSON { .object(["kind": .string(kind), "id": .string(id)]) }
}
@MainActor final class FeedReadState: ObservableObject {
    @Published private(set) var count: Int?
    @Published private(set) var busy = false
    @Published private(set) var error = ""
    var active = true
    private weak var model: AppModel?
    private var generation = -1
    private var runToken = UUID()
    private var memberID: String?
    private var pending = Set<FeedReadItem>()
    private var acknowledged = Set<FeedReadItem>()
    private var retryDelay: Double = 2
    private var flushTask: Task<Void, Never>?
    private var valid: Bool { model?.authenticationGeneration == generation && model?.member != nil }
    func run(_ model: AppModel) async {
        let token = UUID(); runToken = token
        flushTask?.cancel(); flushTask = nil
        if memberID != model.member?.id { pending.removeAll(); acknowledged.removeAll(); count = nil }
        memberID = model.member?.id; busy = false
        self.model = model; generation = model.authenticationGeneration
        defer { if runToken == token { flushTask?.cancel(); flushTask = nil; pending.removeAll(); acknowledged.removeAll(); count = nil; Self.badge(0) } }
        while !Task.isCancelled && valid && runToken == token {
            if active { await refresh(); schedule() }
            do { try await Task.sleep(for: .seconds(30)) } catch { break }
        }
    }
    func seen(_ item: FeedReadItem) {
        guard valid, active, !acknowledged.contains(item), pending.count < 1000 else { return }
        pending.insert(item); schedule()
    }
    private func schedule() {
        guard valid, active, !pending.isEmpty, flushTask == nil else { return }
        let delay = retryDelay
        flushTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self else { return }
            self.flushTask = nil
            await self.flush()
        }
    }
    private func apply(_ response: JSON) {
        guard valid, !Task.isCancelled, case .number(let n) = response["count"], n >= 0, n <= Double(Int32.max), n.rounded() == n else { return }
        count = Int(n); Self.badge(Int(n))
    }
    func refresh() async {
        guard valid, active, !busy, let model else { return }
        let token = runToken
        busy = true; defer { if runToken == token { busy = false } }
        do { let response = try await model.api.social("/feed/unread"); if runToken == token { apply(response) } } catch { /* Reconcile on foreground or next bounded refresh. */ }
    }
    private func flush() async {
        guard valid, active, !busy, let model else { schedule(); return }
        let batch = Array(pending.prefix(100)); guard !batch.isEmpty else { return }
        let token = runToken
        busy = true
        do {
            let response = try await model.api.social("/feed/read", method: "PUT", body: .object(["items": .array(batch.map(\.json))]))
            guard runToken == token, valid, !Task.isCancelled else { if runToken == token { busy = false }; return }
            retryDelay = 2; pending.subtract(batch); acknowledged.formUnion(batch)
            if acknowledged.count > 2000 { acknowledged = Set(batch) }
            apply(response)
        } catch { if runToken == token { retryDelay = min(60, retryDelay * 2) } }
        if runToken == token { busy = false; schedule() }
    }
    func markAll() async {
        guard valid, !busy, let model else { return }
        let token = runToken
        busy = true; error = ""; defer { if runToken == token { busy = false } }
        do {
            let response = try await model.api.social("/feed/read-all", method: "PUT", body: .object([:]))
            guard runToken == token, valid, !Task.isCancelled else { return }
            pending.removeAll(); acknowledged.removeAll(); apply(response)
        } catch { if runToken == token { self.error = "Could not mark the feed read. Please try again." } }
    }
    static func badge(_ count: Int) {
        #if os(macOS)
        NSApplication.shared.dockTile.badgeLabel = count > 0 ? String(count) : nil
        #else
        UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
        #endif
    }
}
private struct FeedViewportKey: EnvironmentKey { static let defaultValue = CGRect.zero }
private struct FeedActiveKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var feedViewport: CGRect { get { self[FeedViewportKey.self] } set { self[FeedViewportKey.self] = newValue } }
    var feedReadActive: Bool { get { self[FeedActiveKey.self] } set { self[FeedActiveKey.self] = newValue } }
}
private struct FeedFrameKey: PreferenceKey {
    static let defaultValue = CGRect.zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}
struct FeedReadVisibility: ViewModifier {
    let item: FeedReadItem
    let ready: Bool
    @EnvironmentObject private var reads: FeedReadState
    @Environment(\.feedViewport) private var viewport
    @Environment(\.feedReadActive) private var selected
    @Environment(\.scenePhase) private var phase
    @State private var frame = CGRect.zero
    private var eligible: Bool { ready && selected && phase == .active && FeedVisibility.qualifies(frame: frame, viewport: viewport) }
    func body(content: Content) -> some View {
        content.background(GeometryReader { geometry in Color.clear.preference(key: FeedFrameKey.self, value: geometry.frame(in: .global)) })
            .onPreferenceChange(FeedFrameKey.self) { frame = $0 }
            .task(id: eligible) {
                guard eligible else { return }
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                guard !Task.isCancelled, eligible else { return }
                reads.seen(item)
            }
    }
}
enum FeedVisibility {
    static func qualifies(frame: CGRect, viewport: CGRect) -> Bool {
        guard frame.width > 0, frame.height > 0, viewport.width > 0, viewport.height > 0 else { return false }
        let visible = frame.intersection(viewport)
        return !visible.isNull && visible.width > 0 && visible.height >= min(frame.height / 2, viewport.height / 2)
    }
}

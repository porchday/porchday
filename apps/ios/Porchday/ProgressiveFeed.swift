import Foundation

/// Preserve server order and sequential vault access, but publish each verified
/// result before decoding the next. Never publish after cancellation/invalidation.
@MainActor enum ProgressiveFeed {
    @discardableResult
    static func decode<Raw, Item>(
        _ rows: [Raw],
        isCurrent: @MainActor () -> Bool,
        open: @MainActor (Raw) async -> Item,
        publish: @MainActor ([Item]) -> Void
    ) async -> Bool {
        var opened: [Item] = []
        for row in rows {
            guard !Task.isCancelled, isCurrent() else { return false }
            let item = await open(row)
            guard !Task.isCancelled, isCurrent() else { return false }
            opened.append(item)
            publish(opened)
            // Give SwiftUI an opportunity to render before more vault work.
            await Task.yield()
        }
        return !Task.isCancelled && isCurrent()
    }
}

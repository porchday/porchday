import Foundation

enum ComposerTimerChoice: Equatable {
    case inherit
    case after(Int)
    case custom(Date)
}

/// A reply inherits an absolute instant, never a new copy of its parent's duration.
struct CommentDeadline: Equatable {
    let postExpiry: Date?
    let parentExpiry: Date?
    let isReply: Bool
    var inherited: Date? { [postExpiry, parentExpiry].compactMap { $0 }.min() }
    var inheritedFromPost: Bool { isReply && postExpiry != nil && inherited == postExpiry }

    enum Invalid: LocalizedError, Equatable {
        case parentExpired, notFuture, laterThanParent
        var errorDescription: String? {
            switch self {
            case .parentExpired: "The parent has expired. This comment cannot be published."
            case .notFuture: "Choose a future expiration time."
            case .laterThanParent: "Choose the same deadline as the parent or an earlier time."
            }
        }
    }

    func deadline(for choice: ComposerTimerChoice, now: Date) throws -> Date? {
        if let inherited, inherited <= now { throw Invalid.parentExpired }
        let selected: Date?
        switch choice {
        case .inherit: selected = inherited
        case .after(let seconds):
            guard seconds > 0 else { throw Invalid.notFuture }
            selected = now.addingTimeInterval(Double(seconds))
        case .custom(let date): selected = date
        }
        if let selected {
            guard selected.timeIntervalSince1970.isFinite, selected > now else { throw Invalid.notFuture }
            if let inherited, selected > inherited { throw Invalid.laterThanParent }
        }
        return selected
    }

    func validationMessage(for choice: ComposerTimerChoice, now: Date) -> String? {
        do { _ = try deadline(for: choice, now: now); return nil }
        catch { return error.localizedDescription }
    }

    func suggestedShorter(now: Date) -> Date {
        guard let inherited, inherited > now else { return now.addingTimeInterval(3600) }
        return now.addingTimeInterval(min(3600, inherited.timeIntervalSince(now) / 2))
    }

    func warning(now: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        guard let inherited else { return nil }
        let subject = isReply ? "This reply will be deleted with the comment" : "This comment will be deleted with the post"
        let original = inheritedFromPost ? " This deadline is inherited from the original post." : ""
        return "\(subject) on \(Self.absolute(inherited, locale: locale, timeZone: timeZone)) (\(Self.remaining(until: inherited, now: now))).\(original) You can make its timeout shorter."
    }

    static func absolute(_ date: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale; formatter.timeZone = timeZone
        formatter.dateStyle = .medium; formatter.timeStyle = .medium
        return formatter.string(from: date)
    }

    static func remaining(until date: Date, now: Date) -> String {
        let interval = date.timeIntervalSince(now)
        guard interval.isFinite, interval > 0 else { return "expired" }
        let seconds = Int(min(ceil(interval), Double(Int.max / 2)))
        let units = [(86400, "day"), (3600, "hour"), (60, "minute"), (1, "second")]
        var rest = seconds, parts: [String] = []
        for (size, name) in units {
            let amount = rest / size; rest %= size
            if amount > 0 { parts.append("\(amount) \(name)\(amount == 1 ? "" : "s")") }
            if parts.count == 2 { break }
        }
        return parts.joined(separator: ", ") + " remaining"
    }

    static func expiry(of row: JSON) -> Date? {
        [row["effective_expires_at"], row["expires_at"], row["envelope"]["context"]["expiresAt"]]
            .compactMap { $0.string.flatMap(PorchDate.parse) }.min()
    }
}

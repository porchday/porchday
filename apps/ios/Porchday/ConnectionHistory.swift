import Foundation

enum ConnectionHistory: String, CaseIterable {
    case full, future
    static let newConnectionDefault: Self = .full
    static func persisted(_ value: JSON) -> Self { Self(rawValue: value.string ?? "") ?? .future }
    var title: String { self == .full ? "Share full history (recommended)" : "Only share new posts" }
}

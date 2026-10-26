import Foundation

/// Values are part of the signed content context; labels never change their meaning.
enum SharingAudience: String, CaseIterable, Identifiable, Sendable {
    case connections, friends, family, onlyMe = "only_me"
    var id: String { rawValue }
    var label: String {
        switch self {
        case .connections: "Friends & family"
        case .friends: "Friends only"
        case .family: "Family only"
        case .onlyMe: "Only me"
        }
    }
}

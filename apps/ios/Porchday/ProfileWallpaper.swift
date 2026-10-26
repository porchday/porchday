import Foundation

/// These identifiers are shared with the web client. Profile values are never URLs or executable markup.
enum ProfileWallpaper: String, CaseIterable, Identifiable, Sendable {
    case none
    case porchStars = "porch-stars"
    case orangeChecker = "orange-checker"
    case sunnyDaisies = "sunny-daisies"
    case midnightDiamonds = "midnight-diamonds"
    var id: String { rawValue }
    static let starters: [ProfileWallpaper] = [.porchStars, .orangeChecker, .sunnyDaisies, .midnightDiamonds]
    var label: String {
        switch self {
        case .none: "No pattern"
        case .porchStars: "Stars & arrows"
        case .orangeChecker: "Checkerboard"
        case .sunnyDaisies: "Daisies"
        case .midnightDiamonds: "Diamonds"
        }
    }
    static func displayed(_ value: JSON, standardTheme: Bool = false) -> ProfileWallpaper {
        guard !standardTheme, let raw = value.string else { return .none }
        return ProfileWallpaper(rawValue: raw) ?? .none
    }
    static func applying(_ choice: ProfileWallpaper, to profile: JSON, changed: Bool) -> JSON {
        // Unknown future/imported choices survive unrelated edits, but never render as remote content.
        changed ? profile.replacing("wallpaper", with: .string(choice.rawValue)) : profile
    }
}

enum InitialProfileWallpaper {
    static func hasSavedEnvelope(_ profile: JSON) -> Bool {
        switch profile["envelope"] {
        case .null: false
        case .object(let fields): !fields.isEmpty
        default: true // Do not replace malformed or future saved data either.
        }
    }

    /// Revision-one creation is atomic at the server. Existing encrypted profiles always win.
    /// A cosmetic failure propagates to the caller, which must keep the unlocked account usable.
    @MainActor static func initialize(
        read: () async throws -> JSON,
        create: (JSON) async throws -> Void,
        choose: () -> ProfileWallpaper = { ProfileWallpaper.starters.randomElement()! }
    ) async throws -> Bool {
        try Task.checkCancellation()
        guard !hasSavedEnvelope(try await read()) else { return false }
        try Task.checkCancellation()
        let selected = choose()
        guard ProfileWallpaper.starters.contains(selected) else { return false }
        let payload: JSON = .object([
            "wallpaper": .string(selected.rawValue), "theme": .string("apricot"),
            "font": .string("serif"), "sectionOrder": .string("about-first")
        ])
        do { try await create(payload); return true }
        catch PorchError.api(let code, _, _) where code == "REVISION_CHANGED" {
            // A concurrent initializer/editor won. Never increase the revision to overwrite it.
            if hasSavedEnvelope(try await read()) { return false }
            throw PorchError.api(code: code, message: "The profile changed. Try again later.", details: .null)
        }
    }
}

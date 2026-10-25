import XCTest
import SwiftUI
@testable import Porchday

final class ProfileWallpaperTests: XCTestCase {
    @MainActor func testStarterIsPersistedOnceAndNeverRerolled() async throws {
        var stored: JSON = .object(["envelope": .null])
        var payload: JSON = .null
        var choices = 0
        var writes = 0
        let first = try await InitialProfileWallpaper.initialize(read: { stored }, create: { value in
            writes += 1; payload = value
            stored = .object(["envelope": .object(["context": .object(["revision": .number(1)]), "ciphertext": .string("synthetic saved envelope")])])
        }, choose: { choices += 1; return .sunnyDaisies })
        let second = try await InitialProfileWallpaper.initialize(read: { stored }, create: { _ in writes += 1 }, choose: { choices += 1; return .porchStars })
        XCTAssertTrue(first); XCTAssertFalse(second)
        XCTAssertEqual(writes, 1); XCTAssertEqual(choices, 1)
        XCTAssertEqual(payload["wallpaper"], .string("sunny-daisies"))
        XCTAssertEqual(payload["theme"], .string("apricot"))
    }

    @MainActor func testOlderOrUnknownSavedProfileIsNeverReplaced() async throws {
        let saved: [JSON] = [.object(["ciphertext": .string("older profile without wallpaper")]), .string("future envelope")]
        for envelope in saved {
            let created = try await InitialProfileWallpaper.initialize(read: { .object(["envelope": envelope]) }, create: { _ in XCTFail("Existing data must win") }, choose: { XCTFail("No reroll"); return .porchStars })
            XCTAssertFalse(created)
        }
    }

    @MainActor func testAllCuratedTilesRenderNatively() {
        for choice in ProfileWallpaper.starters {
            let renderer = ImageRenderer(content: WallpaperBackground(wallpaper: choice).frame(width: 384, height: 304))
            renderer.scale = 1
            let image = renderer.uiImage
            XCTAssertNotNil(image, choice.rawValue)
            XCTAssertEqual(image?.size.width, 384, choice.rawValue)
            XCTAssertEqual(image?.size.height, 304, choice.rawValue)
        }
    }

    @MainActor func testConcurrentExistingProfileWinsWithoutSecondWrite() async throws {
        var reads = 0, writes = 0
        let created = try await InitialProfileWallpaper.initialize(read: {
            reads += 1
            return reads == 1 ? .object(["envelope": .object([:])]) : .object(["envelope": .object(["ciphertext": .string("another device saved this")])])
        }, create: { _ in
            writes += 1
            throw PorchError.api(code: "REVISION_CHANGED", message: "Conflict", details: .null)
        }, choose: { .orangeChecker })
        XCTAssertFalse(created); XCTAssertEqual(reads, 2); XCTAssertEqual(writes, 1)
    }

    @MainActor func testUnavailableCosmeticSaveDoesNotRetryOrPretendItPersisted() async {
        var writes = 0
        do {
            _ = try await InitialProfileWallpaper.initialize(read: { .object([:]) }, create: { _ in
                writes += 1; throw PorchError.api(code: "UNAVAILABLE", message: "Try later", details: .null)
            }, choose: { .midnightDiamonds })
            XCTFail("The caller must know the cosmetic save was unavailable")
        } catch { XCTAssertEqual(writes, 1) }
    }

    func testSafeRenderingAndExplicitChoicePreserveImportedFields() throws {
        let imported = try JSON.parse(#"{"wallpaper":"future-pattern","displayName":"Synthetic archive person","bio":"Imported story","avatar":{"id":"synthetic-photo"}}"#)
        XCTAssertEqual(ProfileWallpaper.displayed(imported["wallpaper"]), .none)
        XCTAssertEqual(ProfileWallpaper.displayed(.string("https://example.invalid/image")), .none)
        XCTAssertEqual(ProfileWallpaper.displayed(.string("porch-stars"), standardTheme: true), .none)
        XCTAssertEqual(ProfileWallpaper.applying(.none, to: imported, changed: false), imported)
        let edited = ProfileWallpaper.applying(.orangeChecker, to: imported, changed: true)
        XCTAssertEqual(edited["wallpaper"], .string("orange-checker"))
        XCTAssertEqual(edited["bio"], imported["bio"])
        XCTAssertEqual(edited["avatar"], imported["avatar"])
        XCTAssertEqual(try JSON.parse(edited.serialized()), edited)
        XCTAssertEqual(ProfileWallpaper.applying(.none, to: edited, changed: true)["wallpaper"], .string("none"))
        let removal = SurfacePhotoRemoval(payload: edited, slots: ["avatar"], removed: ["avatar"])
        XCTAssertEqual(removal.payload["wallpaper"], .string("orange-checker"))
        XCTAssertEqual(Set(ProfileWallpaper.starters.map(\.rawValue)), Set(["porch-stars", "orange-checker", "sunny-daisies", "midnight-diamonds"]))
    }
}

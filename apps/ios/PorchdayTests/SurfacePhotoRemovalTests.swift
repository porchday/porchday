import XCTest
@testable import Porchday

final class SurfacePhotoRemovalTests: XCTestCase {
    private func photo(_ id: String) -> JSON { .object(["id": .string(id), "alt": .string("Garden")]) }

    func testProfileRemovalKeepsOtherFieldsAndExactIDs() {
        let profile: JSON = .object(["avatar": photo("avatar-id"), "cover": photo("cover-id"), "background": photo("background-id"), "displayName": .string("Jane")])
        let plan = SurfacePhotoRemoval(payload: profile, slots: ["avatar", "cover", "background"], removed: ["avatar", "background"])
        XCTAssertEqual(plan.payload, .object(["cover": photo("cover-id"), "displayName": .string("Jane")]))
        XCTAssertEqual(plan.removals, .array([
            .object(["id": .string("avatar-id"), "slot": .string("avatar")]),
            .object(["id": .string("background-id"), "slot": .string("background")])
        ]))
        XCTAssertEqual(profile["avatar"], photo("avatar-id"))
    }

    func testUndoAndReplacementDoNotDeleteCurrentPhoto() {
        let profile: JSON = .object(["avatar": photo("original")])
        let undo = SurfacePhotoRemoval(payload: profile, slots: ["avatar"], removed: [])
        XCTAssertEqual(undo.payload, profile)
        XCTAssertEqual(undo.removals, .array([]))
        let replacement = SurfacePhotoRemoval(payload: profile, slots: ["avatar"], removed: ["avatar"], replaced: ["avatar"])
        XCTAssertEqual(replacement.removals, .array([]))
    }

    func testGroupImageRemovalAndEmptySlot() {
        let group: JSON = .object(["image": photo("other-editor-image"), "name": .string("Book club")])
        let plan = SurfacePhotoRemoval(payload: group, slots: ["image"], removed: ["image"])
        XCTAssertEqual(plan.payload, .object(["name": .string("Book club")]))
        XCTAssertEqual(plan.removals, .array([.object(["id": .string("other-editor-image"), "slot": .string("image")])]))
        let empty = SurfacePhotoRemoval(payload: .object([:]), slots: ["image"], removed: ["image"])
        XCTAssertEqual(empty.removals, .array([]))
    }
}

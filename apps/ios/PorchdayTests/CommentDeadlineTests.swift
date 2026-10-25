import XCTest
import SwiftUI
@testable import Porchday

final class CommentDeadlineTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_900_000_000)
    private let locale = Locale(identifier: "en_US_POSIX")
    private let zone = TimeZone(secondsFromGMT: 0)!

    func testInheritanceKeepsTheEarliestAbsoluteInstantWithoutRestartingTimer() throws {
        let post = now.addingTimeInterval(1800), comment = now.addingTimeInterval(900)
        let context = CommentDeadline(postExpiry: post, parentExpiry: comment, isReply: true)
        XCTAssertEqual(try context.deadline(for: .inherit, now: now), comment)
        XCTAssertEqual(try context.deadline(for: .inherit, now: now.addingTimeInterval(400)), comment)
        XCTAssertFalse(context.inheritedFromPost)
        let earlierPost = CommentDeadline(postExpiry: comment, parentExpiry: post, isReply: true)
        XCTAssertEqual(earlierPost.inherited, comment)
        XCTAssertTrue(earlierPost.inheritedFromPost)
        XCTAssertNil(try CommentDeadline(postExpiry: nil, parentExpiry: nil, isReply: false).deadline(for: .inherit, now: now))
    }

    func testCustomShorteningWorksBelowAnHourAndBelowAMinute() throws {
        for seconds in [1800.0, 40.0] {
            let parent = now.addingTimeInterval(seconds)
            let context = CommentDeadline(postExpiry: parent, parentExpiry: nil, isReply: false)
            let suggested = context.suggestedShorter(now: now)
            XCTAssertGreaterThan(suggested, now)
            XCTAssertLessThan(suggested, parent)
            XCTAssertEqual(try context.deadline(for: .custom(suggested), now: now), suggested)
            XCTAssertThrowsError(try context.deadline(for: .after(3600), now: now)) { error in
                XCTAssertEqual(error as? CommentDeadline.Invalid, .laterThanParent)
            }
        }
    }

    func testExpiredPastAndLongerSelectionsCannotPublish() throws {
        let bound = now.addingTimeInterval(600)
        let context = CommentDeadline(postExpiry: bound, parentExpiry: nil, isReply: false)
        for date in [now, now.addingTimeInterval(-1)] {
            XCTAssertThrowsError(try context.deadline(for: .custom(date), now: now)) { error in
                XCTAssertEqual(error as? CommentDeadline.Invalid, .notFuture)
            }
        }
        XCTAssertEqual(try context.deadline(for: .custom(bound), now: now), bound)
        XCTAssertThrowsError(try context.deadline(for: .custom(bound.addingTimeInterval(1)), now: now))
        XCTAssertThrowsError(try context.deadline(for: .inherit, now: bound)) { error in
            XCTAssertEqual(error as? CommentDeadline.Invalid, .parentExpired)
        }
    }

    func testChangedParentRequiresAValidNewChoiceWithoutSilentlyClampingTheOldCustomValue() throws {
        let chosen = now.addingTimeInterval(1200)
        let old = CommentDeadline(postExpiry: now.addingTimeInterval(1800), parentExpiry: nil, isReply: false)
        XCTAssertEqual(try old.deadline(for: .custom(chosen), now: now), chosen)
        let refreshed = CommentDeadline(postExpiry: now.addingTimeInterval(600), parentExpiry: nil, isReply: false)
        XCTAssertNotNil(refreshed.validationMessage(for: .custom(chosen), now: now))
        XCTAssertEqual(try refreshed.deadline(for: .inherit, now: now), now.addingTimeInterval(600))
        XCTAssertEqual(chosen, now.addingTimeInterval(1200))
    }

    func testWarningsDistinguishPostReplyAndOriginalPostWithAccessibleCountdown() throws {
        let post = now.addingTimeInterval(1800)
        let direct = CommentDeadline(postExpiry: post, parentExpiry: post, isReply: false)
        let inheritedReply = CommentDeadline(postExpiry: post, parentExpiry: post, isReply: true)
        let shorterReply = CommentDeadline(postExpiry: post, parentExpiry: now.addingTimeInterval(300), isReply: true)
        let text = try XCTUnwrap(direct.warning(now: now, locale: locale, timeZone: zone))
        XCTAssertTrue(text.hasPrefix("This comment will be deleted with the post"))
        XCTAssertTrue(text.contains(CommentDeadline.absolute(post, locale: locale, timeZone: zone)))
        XCTAssertTrue(text.contains("30 minutes remaining"))
        XCTAssertFalse(text.contains("original post"))
        let reply = try XCTUnwrap(inheritedReply.warning(now: now, locale: locale, timeZone: zone))
        XCTAssertTrue(reply.hasPrefix("This reply will be deleted with the comment"))
        XCTAssertTrue(reply.contains("This deadline is inherited from the original post."))
        XCTAssertFalse(shorterReply.warning(now: now, locale: locale, timeZone: zone)!.contains("original post"))
        XCTAssertEqual(CommentDeadline.remaining(until: now.addingTimeInterval(40), now: now), "40 seconds remaining")
        XCTAssertEqual(CommentDeadline.remaining(until: now, now: now), "expired")
    }

    func testFreshRoutingMetadataPreservesAnEarlierAncestorBound() {
        let short = now.addingTimeInterval(20), long = now.addingTimeInterval(100)
        let row: JSON = .object(["effective_expires_at": .string(PorchDate.string(short)),
                                 "expires_at": .string(PorchDate.string(long)),
                                 "envelope": .object(["context": .object(["expiresAt": .null])])])
        XCTAssertEqual(CommentDeadline.expiry(of: row), short)
    }

    @MainActor func testInheritedWarningRendersAtLargeAccessibleTypeOnNarrowWidth() throws {
        let context = CommentDeadline(postExpiry: now.addingTimeInterval(1800), parentExpiry: nil, isReply: true)
        let message = try XCTUnwrap(context.warning(now: now, locale: locale, timeZone: zone))
        let renderer = ImageRenderer(content: InheritedDeadlineNotice(message: message)
            .padding(12).frame(width: 320, alignment: .leading).environment(\.dynamicTypeSize, .accessibility3))
        let image = try XCTUnwrap(renderer.uiImage)
        XCTAssertEqual(image.size.width, 320, accuracy: 1)
        XCTAssertGreaterThan(image.size.height, 100)
        XCTAssertLessThan(image.size.height, 2000)
        // The rendered component uses this entire message as one explicit VoiceOver label.
        // This is rendering/label-source evidence, not a human VoiceOver journey.
        XCTAssertTrue(message.contains("remaining"))
    }
}

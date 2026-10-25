import Foundation
import XCTest
@testable import Porchday

private struct HostedSocialFixture: Decodable {
    let v: Int
    let synthetic: Bool
    let scenario, origin, run, attempt, expiresAt, email, password, memberId, recoverySecret: String
    let webPostId, webCommentId, webReplyId, nativeCommentId, nativeReplyId: String
    let webCommentExpiresAt, webReplyExpiresAt: String
    func date(_ value: String) throws -> Date {
        guard let date = PorchDate.parse(value) else { throw HostedFailure.invalidFixture }; return date
    }
    func text(_ kind: String) -> String { "Synthetic native social \(run)/\(attempt) \(kind)" }
    func validate() throws {
        let ids = [memberId, webPostId, webCommentId, webReplyId, nativeCommentId, nativeReplyId]
        guard v == 2, synthetic, scenario == "comments-reactions", origin == "https://staging.porchday.com",
              run.range(of: "^[a-f0-9]{10}$", options: .regularExpression) != nil,
              attempt.range(of: "^[a-f0-9]{8}$", options: .regularExpression) != nil,
              email.count <= 254, email.contains("@"), password.count >= 12, password.count <= 128,
              recoverySecret.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              ids.allSatisfy({ UUID(uuidString: $0) != nil }), Set(ids).count == ids.count
        else { throw HostedFailure.invalidFixture }
        let deadline = try date(expiresAt), remaining = deadline.timeIntervalSinceNow
        guard remaining > 45 * 60, remaining <= 2 * 60 * 60 + 60,
              try date(webCommentExpiresAt) == deadline.addingTimeInterval(-600),
              try date(webReplyExpiresAt) == deadline.addingTimeInterval(-1200) else { throw HostedFailure.invalidFixture }
    }
}

final class HostedSocialInteropTests: XCTestCase {
    @MainActor func testHostedCommentsAndReactions() async throws {
        guard ProcessInfo.processInfo.environment["PORCHDAY_HOSTED_STAGING_TEST"] == "1" else {
            throw XCTSkip("Hosted staging social interoperability is opt-in.")
        }
        let fixture: HostedSocialFixture
        do {
            guard ServerConfiguration.hostedStagingTestEnabled,
                  ServerConfiguration.origin.absoluteString == "https://staging.porchday.com",
                  let encoded = ProcessInfo.processInfo.environment["PORCHDAY_HOSTED_FIXTURE_B64"], encoded.utf8.count <= 16_384,
                  let data = Data(base64Encoded: encoded), data.count <= 12_288 else { throw HostedFailure.invalidFixture }
            fixture = try JSONDecoder().decode(HostedSocialFixture.self, from: data); try fixture.validate()
        } catch { XCTFail("HOSTED_INTEROP_FAILED_FIXTURE"); return }

        let model = AppModel()
        var phase = "LOGIN", failedPhase = "", failure: Error?
        var previousDevices: [Device] = [], nativeDeviceID: String?, signedIn = false
        var cleanupFailure: Error?, cleanupPhase = ""
        do {
            await model.api.clearSession(); SecureStore.clear()
            try await model.signIn(email: fixture.email, password: fixture.password)
            signedIn = true
            guard !model.needsTwoFactor, let member = model.member, member.id == fixture.memberId,
                  member.raw["status"].string == "active" else { throw HostedFailure.unexpectedState }
            previousDevices = model.vault.devices
            guard !previousDevices.isEmpty else { throw HostedFailure.unexpectedState }
            phase = "RECOVERY"
            try await model.vault.unlock(member: member, secret: fixture.recoverySecret)
            guard let native = model.vault.device, !previousDevices.contains(where: { $0.id == native.id }) else { throw HostedFailure.unexpectedState }
            nativeDeviceID = native.id

            phase = "WEB_POST"
            let detail = try await model.api.social("/posts/" + fixture.webPostId)
            let post = detail["post"], postPayload = try await model.vault.open(post)
            try checkContent(post, fixture: fixture, id: fixture.webPostId, kind: "post", parent: nil, expiry: fixture.expiresAt)
            guard postPayload["text"].string == fixture.text("post"), post["envelope"]["context"]["authorDeviceId"].string != native.id else { throw HostedFailure.unexpectedState }
            phase = "WEB_COMMENTS"
            guard let comment = detail["comments"].array.first(where: { $0["id"].string == fixture.webCommentId }),
                  let reply = detail["comments"].array.first(where: { $0["id"].string == fixture.webReplyId }) else { throw HostedFailure.unexpectedState }
            try checkContent(comment, fixture: fixture, id: fixture.webCommentId, kind: "comment", parent: fixture.webPostId, expiry: fixture.webCommentExpiresAt)
            try checkContent(reply, fixture: fixture, id: fixture.webReplyId, kind: "comment", parent: fixture.webCommentId, expiry: fixture.webReplyExpiresAt)
            let commentPayload = try await model.vault.open(comment), replyPayload = try await model.vault.open(reply)
            guard commentPayload["text"].string == fixture.text("web-comment"), replyPayload["text"].string == fixture.text("web-reply") else { throw HostedFailure.unexpectedState }

            phase = "WEB_REACTIONS"
            try await checkReactions(detail["reactions"].array, target: fixture.webPostId, payload: postPayload, expected: ["like", "love"], fixture: fixture, model: model)
            try await checkReactions(detail["comment_reactions"].array, target: fixture.webCommentId, payload: commentPayload, expected: ["like", "love"], fixture: fixture, model: model)

            phase = "NATIVE_COMMENTS"
            let inherited = CommentDeadline(postExpiry: try fixture.date(fixture.expiresAt), parentExpiry: try fixture.date(fixture.expiresAt), isReply: false)
            let replyTimer = CommentDeadline(postExpiry: try fixture.date(fixture.expiresAt), parentExpiry: try fixture.date(fixture.webCommentExpiresAt), isReply: true)
            let replyDeadline = try replyTimer.deadline(for: .custom(Date().addingTimeInterval(1200)), now: Date())
            for (id, parent, kind, deadline, parentDeadline) in [
                (fixture.nativeCommentId, fixture.webPostId, "native-comment", try inherited.deadline(for: .inherit, now: Date()), fixture.expiresAt),
                (fixture.nativeReplyId, fixture.webCommentId, "native-reply", replyDeadline, fixture.webCommentExpiresAt)
            ] {
                let payload: JSON = .object(["text": .string(fixture.text(kind)), "reactionSecret": .string(try CryptoVault.randomSecret()),
                    "requestedDeadline": deadline.map { .string(PorchDate.string($0)) } ?? .null])
                let envelope = try await model.vault.seal(payload, member: member, kind: "comment", audience: "only_me", id: id, parent: parent, post: fixture.webPostId, expiry: deadline)
                guard envelope["context"]["authorDeviceId"].string == native.id else { throw HostedFailure.unexpectedState }
                _ = try await model.api.social("/posts/" + fixture.webPostId + "/comments", method: "POST", body: .object([
                    "envelope": envelope, "parent_expires_at": .string(parentDeadline)
                ]))
            }
            phase = "NATIVE_REACTIONS"
            for (pathKind, target, payload, expiry) in [("posts", fixture.webPostId, postPayload, fixture.expiresAt), ("comments", fixture.webCommentId, commentPayload, fixture.webCommentExpiresAt)] {
                guard let secret = payload["reactionSecret"].string else { throw HostedFailure.unexpectedState }
                for emoji in ["laugh", "celebrate"] {
                    let tag = try CryptoVault.tag(secret: secret, target: target, member: member.id, emoji: emoji)
                    let envelope = try await model.vault.seal(.object(["emoji": .string(emoji)]), member: member, kind: "reaction", audience: "only_me", id: tag, parent: target, post: fixture.webPostId, expiry: fixture.date(expiry))
                    let path = "/\(pathKind)/\(target)/reactions/\(tag)"
                    _ = try await model.api.social(path, method: "PUT", body: .object(["envelope": envelope]))
                    _ = try await model.api.social(path, method: "PUT", body: .object(["envelope": envelope]))
                }
            }
            var published = try await model.api.social("/posts/" + fixture.webPostId)
            try await checkReactions(published["reactions"].array, target: fixture.webPostId, payload: postPayload, expected: ["like", "love", "laugh", "celebrate"], fixture: fixture, model: model)
            try await checkReactions(published["comment_reactions"].array, target: fixture.webCommentId, payload: commentPayload, expected: ["like", "love", "laugh", "celebrate"], fixture: fixture, model: model)
            for (kind, target, payload) in [("posts", fixture.webPostId, postPayload), ("comments", fixture.webCommentId, commentPayload)] {
                guard let secret = payload["reactionSecret"].string else { throw HostedFailure.unexpectedState }
                let tag = try CryptoVault.tag(secret: secret, target: target, member: member.id, emoji: "laugh")
                _ = try await model.api.social("/\(kind)/\(target)/reactions/\(tag)", method: "DELETE")
            }
            phase = "VERIFY_NATIVE_SOCIAL"
            published = try await model.api.social("/posts/" + fixture.webPostId)
            for (id, parent, kind) in [(fixture.nativeCommentId, fixture.webPostId, "native-comment"), (fixture.nativeReplyId, fixture.webCommentId, "native-reply")] {
                guard let row = published["comments"].array.first(where: { $0["id"].string == id }) else { throw HostedFailure.unexpectedState }
                let payload = try await model.vault.open(row)
                guard payload["text"].string == fixture.text(kind), row["envelope"]["context"]["authorDeviceId"].string == native.id,
                      let deadline = payload["requestedDeadline"].string else { throw HostedFailure.unexpectedState }
                try checkContent(row, fixture: fixture, id: id, kind: "comment", parent: parent, expiry: deadline)
            }
            try await checkReactions(published["reactions"].array, target: fixture.webPostId, payload: postPayload, expected: ["like", "love", "celebrate"], fixture: fixture, model: model)
            try await checkReactions(published["comment_reactions"].array, target: fixture.webCommentId, payload: commentPayload, expected: ["like", "love", "celebrate"], fixture: fixture, model: model)
        } catch { failedPhase = phase; failure = error }

        // Revoke only the fresh ID returned by this normal enrollment. Never infer
        // an unobserved enrollment from a set difference after a transport error.
        if signedIn {
            do {
                if let id = nativeDeviceID { _ = try await model.api.social("/devices/" + id, method: "DELETE") }
                let devices = try await model.api.social("/devices")["items"].array.map(Device.init)
                for old in previousDevices {
                    guard devices.contains(where: { $0.id == old.id && $0.fingerprint == old.fingerprint && $0.revoked == old.revoked }) else { throw HostedFailure.unexpectedState }
                }
                let extra = devices.filter { candidate in !previousDevices.contains(where: { $0.id == candidate.id }) }
                guard extra.count == (nativeDeviceID == nil ? 0 : 1), extra.allSatisfy({ $0.id == nativeDeviceID && $0.revoked }) else { throw HostedFailure.unexpectedState }
            } catch { cleanupPhase = "DEVICE_CLEANUP"; cleanupFailure = error }
        }
        do {
            _ = try await model.api.auth("sign-out", body: .object([:]))
            let session = try await model.api.auth("get-session", method: "GET")
            guard session["user"]["id"].string == nil else { throw HostedFailure.unexpectedState }
        } catch { if cleanupFailure == nil { cleanupPhase = "LOGOUT"; cleanupFailure = error } }
        await model.api.clearSession(); model.vault.clear(); SecureStore.clear()
        if let failure { XCTFail("HOSTED_INTEROP_FAILED_" + failedPhase + " HOSTED_INTEROP_DIAGNOSTIC_" + hostedDiagnostic(failure)) }
        if let cleanupFailure { XCTFail("HOSTED_INTEROP_FAILED_" + cleanupPhase + " HOSTED_INTEROP_DIAGNOSTIC_" + hostedDiagnostic(cleanupFailure)) }
    }

    private func checkContent(_ row: JSON, fixture: HostedSocialFixture, id: String, kind: String, parent: String?, expiry: String) throws {
        let context = row["envelope"]["context"]
        guard context["id"].string == id, context["kind"].string == kind, context["authorId"].string == fixture.memberId,
              context["audience"].string == "only_me", context["parentId"].string == parent, context["groupId"] == .null,
              context["expiresAt"].string == expiry,
              !row["envelope"]["recipients"].array.isEmpty, row["envelope"]["recipients"].array.allSatisfy({ $0["memberId"].string == fixture.memberId }) else { throw HostedFailure.unexpectedState }
    }
    @MainActor private func checkReactions(_ rows: [JSON], target: String, payload: JSON, expected: Set<String>, fixture: HostedSocialFixture, model: AppModel) async throws {
        guard let secret = payload["reactionSecret"].string, rows.count == expected.count else { throw HostedFailure.unexpectedState }
        var seen = Set<String>()
        for row in rows {
            let content = try await model.vault.open(row), context = row["envelope"]["context"]
            guard let emoji = content["emoji"].string, expected.contains(emoji), seen.insert(emoji).inserted,
                  let tag = row["reaction_tag"].string, row["member_id"].string == fixture.memberId,
                  context["id"].string == tag, context["parentId"].string == target, context["authorId"].string == fixture.memberId,
                  context["kind"].string == "reaction", context["audience"].string == "only_me",
                  try CryptoVault.tag(secret: secret, target: target, member: fixture.memberId, emoji: emoji) == tag else { throw HostedFailure.unexpectedState }
        }
    }
}

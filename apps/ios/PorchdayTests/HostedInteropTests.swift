import Foundation
import XCTest
@testable import Porchday

private struct HostedFixture: Decodable {
    let v: Int
    let synthetic: Bool
    let origin, run, expiresAt, email, password, memberId, recoverySecret: String
    let webPostId, webMediaId, expectedPostText, expectedMediaSHA256: String
    let nativePostId, nativeMediaId, nativeText: String
    var deadline: Date { get throws { guard let date = PorchDate.parse(expiresAt) else { throw HostedFailure.invalidFixture }; return date } }
    func validate() throws {
        guard v == 1, synthetic, origin == "https://staging.porchday.com",
              run.range(of: "^[a-f0-9]{10}$", options: .regularExpression) != nil,
              expectedPostText == "Synthetic web-to-native interoperability " + run,
              nativeText == "Synthetic native-to-web interoperability " + run,
              email.count <= 254, email.contains("@"), password.count >= 12, password.count <= 128,
              recoverySecret.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              expectedMediaSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              [memberId, webPostId, webMediaId, nativePostId, nativeMediaId].allSatisfy({ UUID(uuidString: $0) != nil })
        else { throw HostedFailure.invalidFixture }
        let remaining = try deadline.timeIntervalSinceNow
        guard remaining > 300, remaining <= 2 * 60 * 60 + 60 else { throw HostedFailure.invalidFixture }
    }
}
enum HostedFailure: Error { case invalidFixture, unexpectedState }

// A closed diagnostic vocabulary helps distinguish runtime failures without
// serializing an NSError, provider response, request URL or private fixture.
func hostedDiagnostic(_ error: Error) -> String {
    if let error = error as? PorchError {
        switch error {
        case .message(let message):
            switch message {
            case "Could not save this device's private keys securely.": return "KEYCHAIN_WRITE"
            case "Unlock your device to access Porchday's secure storage.": return "KEYCHAIN_READ"
            case "Your account details are unavailable.": return "MEMBER_SHAPE"
            case "A device identity is incomplete.": return "DEVICE_SHAPE"
            case "Untrusted server address.": return "ORIGIN"
            default: return "CLIENT_OTHER"
            }
        case .api(let code, _, _):
            switch code {
            case "UNAUTHORIZED": return "UNAUTHORIZED"
            case "INVALID_ORIGIN", "ORIGIN_DENIED": return "ORIGIN"
            case "RATE_LIMIT", "RATE_LIMITED": return "RATE_LIMIT"
            case "INVALID_EMAIL_OR_PASSWORD": return "CREDENTIALS"
            case "EMAIL_NOT_VERIFIED": return "EMAIL_UNVERIFIED"
            default: return "API_OTHER"
            }
        }
    }
    if error is DecodingError { return "DECODING" }
    if let error = error as? URLError {
        switch error.code {
        case .timedOut: return "NETWORK_TIMEOUT"
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot: return "NETWORK_TLS"
        default: return "NETWORK_OTHER"
        }
    }
    if error is HostedFailure { return "STATE_MISMATCH" }
    return "OTHER"
}

final class HostedInteropTests: XCTestCase {
    @MainActor func testHostedInteroperability() async throws {
        guard ProcessInfo.processInfo.environment["PORCHDAY_HOSTED_STAGING_TEST"] == "1" else {
            throw XCTSkip("Hosted staging interoperability is opt-in.")
        }
        // All thrown failures are replaced with a fixed phase label. XCTest
        // must never serialize the fixture, credentials, keys or HTTP errors.
        let fixture: HostedFixture
        do {
            guard ServerConfiguration.hostedStagingTestEnabled,
                  ServerConfiguration.origin.absoluteString == "https://staging.porchday.com",
                  let encoded = ProcessInfo.processInfo.environment["PORCHDAY_HOSTED_FIXTURE_B64"],
                  encoded.utf8.count <= 16_384,
                  let data = Data(base64Encoded: encoded), data.count <= 12_288 else { throw HostedFailure.invalidFixture }
            fixture = try JSONDecoder().decode(HostedFixture.self, from: data)
            try fixture.validate()
        } catch {
            XCTFail("HOSTED_INTEROP_FAILED_FIXTURE")
            return
        }
        var phase = "LOGIN"
        let model = AppModel()
        do {
            await model.api.clearSession(); SecureStore.clear()

            phase = "LOGIN"
            try await model.signIn(email: fixture.email, password: fixture.password)
            guard !model.needsTwoFactor, let member = model.member, member.id == fixture.memberId else { throw HostedFailure.unexpectedState }
            let previousDevices = Set(model.vault.devices.map(\.id))
            guard !previousDevices.isEmpty else { throw HostedFailure.unexpectedState }

            phase = "RECOVERY"
            try await model.vault.unlock(member: member, secret: fixture.recoverySecret)
            guard let nativeDevice = model.vault.device, !previousDevices.contains(nativeDevice.id) else { throw HostedFailure.unexpectedState }

            phase = "WEB_POST"
            let webRow = try await model.api.social("/posts/" + fixture.webPostId)["post"]
            let webPayload = try await model.vault.open(webRow)
            guard webPayload["text"].string == fixture.expectedPostText,
                  webPayload["media"].array.contains(where: { $0["id"].string == fixture.webMediaId }),
                  webRow["envelope"]["context"]["authorId"].string != member.id else { throw HostedFailure.unexpectedState }

            phase = "WEB_MEDIA"
            let webBytes = try await model.api.bytes("/api/v1/media/" + fixture.webMediaId + "/bytes")
            let webEnvelope = try JSONDecoder().decode(JSON.self, from: webBytes)
            let photo = try await model.vault.open(.object(["id": .string(fixture.webMediaId), "envelope": webEnvelope]))
            guard photo["mime"].string == "image/jpeg", let encodedPhoto = photo["bytes"].string,
                  let jpeg = Data(base64Encoded: encodedPhoto), jpeg.count <= 64 * 1024,
                  PortableArchive.digest(jpeg) == fixture.expectedMediaSHA256 else { throw HostedFailure.unexpectedState }
            let decodedImage = try PhotoPipeline.safelyDecode(jpeg)
            guard decodedImage.cgImage?.width == 16, decodedImage.cgImage?.height == 16 else { throw HostedFailure.unexpectedState }

            phase = "NATIVE_MEDIA"
            let metadata: JSON = .object([
                "id": .string(fixture.nativeMediaId), "mime": .string("image/jpeg"),
                "name": .string("synthetic-interop.jpg"), "alt": .string("Synthetic interoperability gradient"),
                "width": .number(16), "height": .number(16)
            ])
            let mediaEnvelope = try await model.vault.seal(metadata.replacing("bytes", with: .string(jpeg.base64EncodedString())),
                member: member, kind: "media", audience: "connections", id: fixture.nativeMediaId,
                parent: fixture.nativePostId, expiry: fixture.deadline)
            let mediaBytes = try JSONEncoder().encode(mediaEnvelope)
            let reservation = try await model.api.social("/media", method: "POST", body: .object([
                "id": .string(fixture.nativeMediaId), "envelope": mediaEnvelope, "byte_size": .number(Double(mediaBytes.count))
            ]))
            guard let upload = reservation["upload_url"].string else { throw HostedFailure.unexpectedState }
            _ = try await model.api.bytes(upload, method: "PUT", body: mediaBytes)

            phase = "NATIVE_POST"
            let payload: JSON = .object(["text": .string(fixture.nativeText), "media": .array([metadata]),
                                          "reactionSecret": .string(try CryptoVault.randomSecret())])
            let nativeEnvelope = try await model.vault.seal(payload, member: member, kind: "post", audience: "connections",
                id: fixture.nativePostId, expiry: fixture.deadline)
            guard nativeEnvelope["context"]["authorDeviceId"].string == nativeDevice.id else { throw HostedFailure.unexpectedState }
            let published = try await model.api.social("/posts", method: "POST", body: .object([
                "envelope": nativeEnvelope, "media_ids": .array([.string(fixture.nativeMediaId)])
            ]))
            guard published["id"].string == fixture.nativePostId else { throw HostedFailure.unexpectedState }

            phase = "VERIFY_NATIVE_POST"
            let nativeRow = try await model.api.social("/posts/" + fixture.nativePostId)["post"]
            guard try await model.vault.open(nativeRow) == payload else { throw HostedFailure.unexpectedState }
            let storedBytes = try await model.api.bytes("/api/v1/media/" + fixture.nativeMediaId + "/bytes")
            let storedEnvelope = try JSONDecoder().decode(JSON.self, from: storedBytes)
            let storedPhoto = try await model.vault.open(.object(["id": .string(fixture.nativeMediaId), "envelope": storedEnvelope]))
            guard storedPhoto["bytes"].string == jpeg.base64EncodedString() else { throw HostedFailure.unexpectedState }

            phase = "LOGOUT"
            _ = try await model.api.auth("sign-out", body: .object([:]))
            await model.api.clearSession(); model.vault.clear(); SecureStore.clear()
            let afterLogout = try await model.api.auth("get-session", method: "GET")
            guard afterLogout["user"]["id"].string == nil else { throw HostedFailure.unexpectedState }
        } catch {
            _ = try? await model.api.auth("sign-out", body: .object([:]))
            await model.api.clearSession(); model.vault.clear(); SecureStore.clear()
            XCTFail("HOSTED_INTEROP_FAILED_" + phase + " HOSTED_INTEROP_DIAGNOSTIC_" + hostedDiagnostic(error))
        }
    }
}

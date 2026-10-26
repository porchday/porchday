import XCTest
import Foundation
@testable import Porchday

final class ReactionsTests: XCTestCase {
    private func fixture() throws -> JSON {
        let url = try XCTUnwrap(Bundle(for:Self.self).url(forResource:"reactions-v1",withExtension:"json"))
        return try JSONDecoder().decode(JSON.self,from:Data(contentsOf:url))
    }
    private func custom() throws -> ReactionValue {
        let row = try XCTUnwrap(try fixture()["vectors"].array.first(where:{$0["payload"]["custom"] != .null}))
        return try ReactionValue.parse(row["payload"])
    }
    @MainActor func testSharedJavaScriptGoAndSwiftReactionIdentitiesAndMACs() throws {
        let data = try fixture()
        XCTAssertEqual(data["vectors"].array.count,12)
        for vector in data["vectors"].array {
            let value = try ReactionValue.parse(vector["payload"])
            XCTAssertEqual(value.payload,vector["payload"])
            XCTAssertEqual(try CryptoVault.tag(secret:try XCTUnwrap(data["secret"].string),target:try XCTUnwrap(data["targetId"].string),member:try XCTUnwrap(data["memberId"].string),emoji:value.id),vector["tag"].string,vector["name"].string ?? "")
        }
    }
    func testBundledUnicode17CatalogAndCanonicalAliasesPreserveLegacyIDs() throws {
        XCTAssertEqual(UnicodeReactions.entries.count,3944)
        XCTAssertEqual(try ReactionValue.emoji("👍").id,"like")
        XCTAssertEqual(try ReactionValue.emoji("❤").id,"love")
        XCTAssertEqual(try ReactionValue.emoji("☀").id,"sunshine")
        for entry in UnicodeReactions.entries {
            let canonical = try ReactionValue.emoji(entry.unicode)
            for alias in entry.aliases { XCTAssertEqual(try ReactionValue.emoji(alias).id,canonical.id) }
        }
        for bad in ["hello","😀😀","", "😀\n", "\u{200d}", "<script>",String(repeating:"😀",count:100)] { XCTAssertThrowsError(try ReactionValue.emoji(bad)) }
    }
    func testDescriptorValidationRejectsMismatchedIDsNamesAndInjectedFields() throws {
        let value = try custom(),unicode = try ReactionValue.emoji("🦄")
        XCTAssertThrowsError(try ReactionValue.parse(unicode.payload.replacing("emoji",with:.string("u1_"+String(repeating:"0",count:64)))))
        XCTAssertThrowsError(try ReactionValue.parse(unicode.payload.replacing("custom",with:.object([:]))))
        XCTAssertThrowsError(try ReactionValue.parse(value.payload.replacing("emoji",with:.string("love"))))
        XCTAssertThrowsError(try ReactionValue.parse(value.payload.replacing("externalURL",with:.string("https://example.test/image"))))
        for name in ["Uppercase","has space","../image","","name\n","name\r","name\u{2028}",String(repeating:"a",count:33),"🙂"] { XCTAssertThrowsError(try ReactionValue.custom(name:name,png:try XCTUnwrap(value.png))) }
        let encoded = try XCTUnwrap(value.payload["custom"]["png"].string)
        XCTAssertThrowsError(try ReactionValue.parse(value.payload.replacing("custom",with:value.payload["custom"].replacing("png",with:.string(encoded+"\n")))))
    }
    func testReceivedCustomBytesRetainExactIdentityAndTransparency() throws {
        let value = try custom(),bytes = try XCTUnwrap(value.png),image = try ReactionPNG.decode(bytes)
        XCTAssertLessThanOrEqual(image.width,128);XCTAssertLessThanOrEqual(image.height,128)
        XCTAssertTrue([.first,.last,.premultipliedFirst,.premultipliedLast].contains(image.alphaInfo))
        let reused = try ReactionValue.custom(name:"renamed",png:bytes)
        XCTAssertEqual(reused.id,value.id);XCTAssertEqual(reused.png,bytes)
        XCTAssertEqual(reused.payload["custom"]["png"],value.payload["custom"]["png"])
    }
    private func chunk(_ name: String, _ body: [UInt8]) -> Data {
        var result: [UInt8] = [],size = UInt32(body.count)
        for shift in [24,16,8,0] { result.append(UInt8((size >> shift) & 255)) }
        let content = Array(name.utf8)+body;result += content;size = ReactionPNG.crc(content[...])
        for shift in [24,16,8,0] { result.append(UInt8((size >> shift) & 255)) }
        return Data(result)
    }
    func testPNGLimitsCRCMetadataAnimationAndTrailingBytesFailClosed() throws {
        let bytes = try XCTUnwrap(try custom().png)
        for bad in [Data(),Data(bytes.dropLast()),bytes+Data([0]),Data(repeating:0,count:32769)] { XCTAssertThrowsError(try ReactionPNG.decode(bad)) }
        var damaged = bytes;damaged[damaged.count-1] ^= 1;XCTAssertThrowsError(try ReactionPNG.decode(damaged))
        for kind in ["acTL","fcTL","fdAT","iCCP","tEXt","iTXt","zTXt"] {
            let injected = bytes.prefix(33)+chunk(kind,[0,0,0,1,0,0,0,0])+bytes.dropFirst(33)
            XCTAssertThrowsError(try ReactionPNG.decode(Data(injected)))
        }
        var header = Array(bytes[16..<29]);header[0] = 0;header[1] = 0;header[2] = 0;header[3] = 129
        let oversized = bytes.prefix(8)+chunk("IHDR",header)+bytes.dropFirst(33)
        XCTAssertThrowsError(try ReactionPNG.decode(Data(oversized)))
    }
    func testLibraryMergePreservesExistingNamesAndRejectsDuplicatesAndOverflow() throws {
        let original = try custom(),renamed = try ReactionValue.custom(name:"another_name",png:try XCTUnwrap(original.png))
        let merged = try EmojiLibraryPayload.merge([original],[renamed])
        XCTAssertEqual(merged,[original]);XCTAssertEqual(try EmojiLibraryPayload.parse(EmojiLibraryPayload.encode(merged)),merged)
        XCTAssertThrowsError(try EmojiLibraryPayload.encode([original,renamed]))
        XCTAssertThrowsError(try EmojiLibraryPayload.encode(Array(repeating:original,count:49)))
        XCTAssertThrowsError(try EmojiLibraryPayload.encode([ReactionValue.legacy("like")]))
        XCTAssertThrowsError(try EmojiLibraryPayload.parse(.object(["customEmojis":.array([]),"public":.bool(true)])))
    }
    func testArchiveRoundTripPreservesOwnCollectionAndReactionImageBytes() throws {
        let reaction = try custom(),owner = UUID().uuidString.lowercased(),payload = try EmojiLibraryPayload.encode([reaction])
        let manifest: JSON = .object(["format":.string("porchday-archive"),"version":.number(1),"member_id":.string(owner),"emojiLibrary":payload,"media":.array([]),"reactions":.array([.object(["payload":reaction.payload])])])
        let reopened = try PortableArchive.read(PortableArchive(manifest:manifest,files:[:]).zip())
        XCTAssertEqual(reopened.manifest["emojiLibrary"],payload)
        XCTAssertEqual(try ReactionValue.parse(reopened.manifest["reactions"].array[0]["payload"]).png,reaction.png)
        let html = String(decoding:try XCTUnwrap(reopened.files["index.html"]),as:UTF8.self)
        XCTAssertTrue(html.contains("data:image/png;base64,"));XCTAssertFalse(html.contains("<script"))
    }
    @MainActor func testReactionSessionRejectsAccountDeviceAndWriteAccessChanges() throws {
        let model = AppModel(), memberID = UUID().uuidString.lowercased(), deviceID = UUID().uuidString.lowercased()
        let member: JSON = .object(["id":.string(memberID),"handle":.string("synthetic"),"status":.string("active")])
        let device: JSON = .object(["id":.string(deviceID),"member_id":.string(memberID),"public_key":.string("synthetic"),"fingerprint":.string(String(repeating:"a",count:64)),"revoked_at":.null])
        model.acceptAuthenticatedMember(try Member(member));model.vault.device = try Device(device)
        let session = try ReactionSession(model);XCTAssertTrue(session.current(model,write:true))
        model.vault.device = try Device(device.replacing("revoked_at",with:.string(PorchDate.string())))
        XCTAssertFalse(session.current(model,write:true));XCTAssertTrue(session.current(model))
        model.vault.device = try Device(device);model.member = try Member(member.replacing("status",with:.string("restricted")))
        XCTAssertFalse(session.current(model,write:true));XCTAssertTrue(session.current(model))
        model.member = try Member(member.replacing("status",with:.string("hold")));XCTAssertFalse(session.current(model))
        model.member = try Member(member);model.vault.device = try Device(device.replacing("id",with:.string(UUID().uuidString.lowercased())))
        XCTAssertFalse(session.current(model));model.vault.device = try Device(device)
        model.acceptAuthenticatedMember(try Member(member));XCTAssertFalse(session.current(model))
    }
    func testLibraryRevisionFloorSurvivesErasedCiphertextAndRejectsInvalidMetadata() throws {
        XCTAssertEqual(try EmojiLibrarySnapshot.revision(.object(["envelope":.null,"revision":.number(8)])),8)
        XCTAssertEqual(try EmojiLibrarySnapshot.revision(.object(["envelope":.null,"revision":.number(0)])),0)
        for value in [JSON.number(-1),.number(1.5),.string("8")] { XCTAssertThrowsError(try EmojiLibrarySnapshot.revision(.object(["envelope":.null,"revision":value]))) }
    }
    @MainActor func testCollectionMergeRetriesOnlyExplicitRevisionConflictsAndKeepsUnknownOutcomesUnknown() async throws {
        let value = try custom();var reads = 0,writes = 0
        let result = try await EmojiLibraryUpdate.merge([value],read:{ reads += 1;return EmojiLibrarySnapshot(revision:reads-1,envelope:.null,entries:[]) },write:{ _,previous in
            writes += 1;XCTAssertEqual(previous.revision,writes-1)
            if writes < 3 { throw PorchError.api(code:"REVISION_CHANGED",message:"changed",details:.null) }
        },ensureCurrent:{})
        XCTAssertEqual(result,[value]);XCTAssertEqual(reads,3);XCTAssertEqual(writes,3)
        reads = 0;writes = 0
        do {
            _ = try await EmojiLibraryUpdate.merge([value],read:{ reads += 1;return EmojiLibrarySnapshot(revision:0,envelope:.null,entries:[]) },write:{ _,_ in writes += 1;throw PorchError.message("Unknown transport outcome") },ensureCurrent:{})
            XCTFail("Unknown write failure was accepted")
        } catch { XCTAssertEqual(reads,1);XCTAssertEqual(writes,1) }
    }
    @MainActor func testCollectionMergeDoesNotWriteAfterAccountChangeOrWhenAlreadyPresent() async throws {
        let value = try custom();var current = true,writes = 0
        do {
            _ = try await EmojiLibraryUpdate.merge([value],read:{ current = false;return EmojiLibrarySnapshot(revision:0,envelope:.null,entries:[]) },write:{ _,_ in writes += 1 },ensureCurrent:{ if !current { throw CancellationError() } })
            XCTFail("A changed account was accepted")
        } catch { XCTAssertEqual(writes,0) }
        let result = try await EmojiLibraryUpdate.merge([value],read:{ EmojiLibrarySnapshot(revision:5,envelope:.null,entries:[value]) },write:{ _,_ in writes += 1 },ensureCurrent:{})
        XCTAssertEqual(result,[value]);XCTAssertEqual(writes,0)
    }
}

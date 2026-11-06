import XCTest
@testable import Porchday
final class SegmentedVideoTests: XCTestCase {
    func testPublishedWireVector() throws {
        let url=try XCTUnwrap(Bundle(for:Self.self).url(forResource:"video-v2",withExtension:"json")),value=try JSONDecoder().decode(JSON.self,from:Data(contentsOf:url))
        let manifest=try SegmentedVideoCrypto.decode(JSONEncoder().encode(value["manifest"])),cipher=try XCTUnwrap(value["ciphertext"].string.flatMap{Data(base64Encoded:$0)}),plain=try XCTUnwrap(value["plaintext"].string.flatMap{Data(base64Encoded:$0)})
        XCTAssertEqual(try SegmentedVideoCrypto.decrypt(cipher,manifest:manifest,index:0),plain)
    }

    func testSegmentsBindStreamIndexSizeAndCiphertext() throws {
        let key=SegmentedVideoCrypto.newKey(),stream=UUID().uuidString.lowercased(),plain=Data("a private video segment".utf8)
        let(cipher,segment)=try SegmentedVideoCrypto.encrypt(plain,key:key,stream:stream,index:0)
        let manifest=VideoV2Manifest(v:2,protocol:"porchday-video-aes256gcm-v2",streamId:stream,key:key,mime:"video/mp4",size:plain.count,duration:1,width:640,height:480,chunkSize:SegmentedVideoCrypto.chunkBytes,segments:[segment])
        XCTAssertEqual(cipher.startIndex,0)
        let decoded=try SegmentedVideoCrypto.decrypt(cipher,manifest:manifest,index:0)
        XCTAssertEqual(decoded.startIndex,0)
        XCTAssertEqual(decoded,plain)
        var corrupt=cipher;corrupt[0]^=1
        XCTAssertThrowsError(try SegmentedVideoCrypto.decrypt(corrupt,manifest:manifest,index:0))
        XCTAssertThrowsError(try SegmentedVideoCrypto.decrypt(cipher.dropLast(),manifest:manifest,index:0))
        XCTAssertThrowsError(try SegmentedVideoCrypto.decrypt(cipher,manifest:manifest,index:1))
        let(_,again)=try SegmentedVideoCrypto.encrypt(plain,key:key,stream:stream,index:0)
        XCTAssertNotEqual(segment.nonce,again.nonce)
    }
    @MainActor func testArchiveAssemblyAndDurableQueueReload() async throws {
        let fixture=try XCTUnwrap(Bundle(for:Self.self).url(forResource:"synthetic-video",withExtension:"mp4")),bytes=try Data(contentsOf:fixture),id=UUID().uuidString.lowercased(),hash=SegmentedVideoCrypto.hash(bytes)
        let segment:JSON = .object(["id":.string(id),"index":.number(0),"path":.string(VideoArchive.path(id,0)),"size":.number(Double(bytes.count)),"sha256":.string(hash)])
        let record:JSON = .object(["id":.string(id),"videoVersion":.number(2),"mime":.string("video/mp4"),"path":.string("photos/\(id).mp4"),"size":.number(Double(bytes.count)),"duration":.number(0.5),"width":.number(160),"height":.number(120),"sha256":.string(hash),"segments":.array([segment])])
        let imported=try await VideoArchive.assemble(record){_ in bytes}
        XCTAssertEqual(try Data(contentsOf:imported.largeVideo!.url),bytes)
        do { _ = try await VideoArchive.assemble(record){_ in Data(bytes.dropLast())};XCTFail("Accepted truncated archive") } catch { }
        let owner=UUID().uuidString.lowercased(),postID=UUID().uuidString.lowercased(),outbox=try NativeVideoOutbox(owner:owner)
        defer{try? FileManager.default.removeItem(at:outbox.directory)}
        let post:JSON = .object(["envelope":.object(["context":.object(["id":.string(postID)]),"ciphertext":.string("synthetic encrypted publication")])])
        try outbox.save(postID,media:[],post:post)
        let reloaded=try NativeVideoOutbox(owner:owner)
        XCTAssertEqual(try reloaded.pending().map(\.id),[postID])
        try reloaded.discard(postID);XCTAssertTrue(try outbox.pending().isEmpty)
    }

    @MainActor func testFileBackedPreparationRetainsAudioAndTrims() async throws {
        let fixture=try XCTUnwrap(Bundle(for:Self.self).url(forResource:"synthetic-video",withExtension:"mp4"))
        let selected=try SelectedVideoFile(copying:fixture)
        let duration=try await LargeVideoPreparation.inspect(selected)
        XCTAssertGreaterThan(duration,0.4)
        let photo=try await LargeVideoPreparation.prepare(selected,resolution:720,start:0.1,end:0.4)
        XCTAssertTrue(photo.bytes.isEmpty)
        XCTAssertNotNil(photo.largeVideo)
        XCTAssertEqual(photo.largeVideo!.duration,0.3,accuracy:0.001)
        XCTAssertFalse(photo.poster.isEmpty)
        XCTAssertThrowsError(try SegmentedVideoCrypto.validate(VideoV2Manifest(v:2,protocol:"porchday-video-aes256gcm-v2",streamId:UUID().uuidString.lowercased(),key:SegmentedVideoCrypto.newKey(),mime:"video/mp4",size:1,duration:601,width:640,height:480,chunkSize:SegmentedVideoCrypto.chunkBytes,segments:[])))
    }
}

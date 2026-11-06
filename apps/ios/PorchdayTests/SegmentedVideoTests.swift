import XCTest
@testable import Porchday
final class SegmentedVideoTests: XCTestCase {
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

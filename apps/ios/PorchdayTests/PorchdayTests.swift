import XCTest
import Porchcrypto
@testable import Porchday

final class PorchdayTests: XCTestCase {
    func testAncestorDeadlineCannotExtend() {
        let parent=Date().addingTimeInterval(50)
        XCTAssertEqual(PorchDate.deadline(seconds:0,parent:parent),parent)
        XCTAssertEqual(PorchDate.deadline(seconds:3600,parent:parent),parent)
        XCTAssertLessThan(PorchDate.deadline(seconds:1,parent:parent)!,parent)
    }
    func testOpenPGPJavaScriptFixtureAndTamperRejection() throws {
        let url=try XCTUnwrap(Bundle(for:Self.self).url(forResource:"openpgp-v1",withExtension:"json"))
        let fixture=try JSONDecoder().decode(JSON.self,from:Data(contentsOf:url)),bob=fixture["bob"],envelope=fixture["envelope"]
        var error:NSError?
        let session=try XCTUnwrap(PorchcryptoNewSession(bob["encryptedPrivateKey"].string,bob["recoverySecret"].string,bob["fingerprint"].string,&error))
        XCTAssertNil(error);defer{session.close()}
        let opened=session.decrypt(try envelope.serialized(),expectedContextJSON:try envelope["context"].serialized(),authorPublicKey:fixture["alice"]["publicKey"].string,error:&error)
        XCTAssertNil(error);XCTAssertEqual(try JSON.parse(opened),fixture["payload"])
        let changed=envelope.replacing("context",with:envelope["context"].replacing("audience",with:.string("only_me")))
        _=session.decrypt(try changed.serialized(),expectedContextJSON:try changed["context"].serialized(),authorPublicKey:fixture["alice"]["publicKey"].string,error:&error)
        XCTAssertNotNil(error)
    }
    @MainActor func testArchiveEncryptionAndCompleteMultipartValidation() throws {
        let owner=UUID().uuidString.lowercased(),set=UUID().uuidString.lowercased()
        let base:JSON = .object(["format":.string("porchday-archive"),"version":.number(1),"member_id":.string(owner),"posts":.array([]),"media":.array([])])
        let first=PortableArchive(manifest:base.replacing("archive_set",with:.object(["id":.string(set),"index":.number(1),"total":.null])),files:[:])
        let last=PortableArchive(manifest:base.replacing("archive_set",with:.object(["id":.string(set),"index":.number(2),"total":.number(2),"complete":.bool(true)])),files:[:])
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString,isDirectory:true)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true);defer{try? FileManager.default.removeItem(at:directory)}
        let secret=try CryptoVault.randomSecret(),a=directory.appendingPathComponent("a.pgp"),b=directory.appendingPathComponent("b.pgp")
        try CryptoVault.archive(first.zip(),secret:secret).write(to:a);try CryptoVault.archive(last.zip(),secret:secret).write(to:b)
        XCTAssertThrowsError(try ArchiveSelection.load(urls:[a],secret:secret))
        XCTAssertThrowsError(try ArchiveSelection.load(urls:[a,b],secret:"wrong"))
        let valid=try ArchiveSelection.load(urls:[b,a],secret:secret)
        XCTAssertEqual(valid.urls.count,2);XCTAssertEqual(valid.memberID,owner)
        let tampered=PortableArchive(manifest:base.replacing("media",with:.array([.object(["id":.string(owner),"path":.string("photos/\(owner).jpg"),"mime":.string("image/jpeg"),"sha256":.string("wrong")])])),files:["photos/\(owner).jpg":Data([1,2,3])])
        XCTAssertThrowsError(try PortableArchive.read(tampered.zip()))
    }
}

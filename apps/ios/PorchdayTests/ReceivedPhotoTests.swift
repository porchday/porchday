import XCTest
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@testable import Porchday

final class ReceivedPhotoTests: XCTestCase {
    private func encoded(_ type: UTType = .jpeg, width: Int = 16, height: Int = 12, orientation: UInt32 = 1) throws -> Data {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(CGColor(gray: 0.5, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage()), bytes = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(bytes, type.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: orientation] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return bytes as Data
    }

    func testDecodesRealJPEGAndPreservesOrientation() throws {
        let decoded = try ReceivedPhoto.decodeJPEG(encoded(orientation: 6))
        XCTAssertEqual(decoded.image.width, 16)
        XCTAssertEqual(decoded.image.height, 12)
        XCTAssertEqual(decoded.orientation, 6)
    }

    func testRejectsRealPNGDespiteAClaimedJPEGMimeType() throws {
        let png = try encoded(.png)
        XCTAssertNotNil(CGImageSourceCreateWithData(png as CFData, nil))
        XCTAssertThrowsError(try ReceivedPhoto.decodeJPEG(png))
    }

    func testRejectsMalformedAndTruncatedJPEG() throws {
        let jpeg = try encoded()
        for data in [Data(), Data([0xff, 0xd8, 0xff, 0xe0, 0, 0]), jpeg.prefix(16), jpeg.prefix(jpeg.count / 2), jpeg.dropLast(2)] {
            XCTAssertThrowsError(try ReceivedPhoto.decodeJPEG(Data(data)))
        }
    }

    func testRejectsOversizedEncodedBytesAndDimensions() throws {
        XCTAssertThrowsError(try ReceivedPhoto.decodeJPEG(Data(repeating: 0, count: 20 * 1024 * 1024 + 1)))
        // A narrow real image exercises the dimension cap without a large decode fixture.
        XCTAssertThrowsError(try ReceivedPhoto.decodeJPEG(encoded(width: 2401, height: 1)))
        XCTAssertThrowsError(try ReceivedPhoto.decodeJPEG(encoded(width: 1, height: 2401)))
        let boundary = try ReceivedPhoto.decodeJPEG(encoded(width: 2400, height: 1))
        XCTAssertEqual(boundary.image.width, 2400)
    }

    func testDecodesExistingWebInteroperabilityJPEG() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "77777777-7777-4777-8777-777777777777", withExtension: "jpg"))
        let decoded = try ReceivedPhoto.decodeJPEG(Data(contentsOf: url))
        XCTAssertEqual(decoded.image.width, 16)
        XCTAssertEqual(decoded.image.height, 16)
    }
}

import XCTest
import UIKit
@testable import Porchday

final class PhotoPipelineTests: XCTestCase {
    @MainActor func testSourceByteLimitIncludes50MiBAndRejectsOneByteMore() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let image = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 12), format: format).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 16, height: 12))
        }
        var source = try XCTUnwrap(image.jpegData(compressionQuality: 0.85))
        // Real, tiny pixels plus source-only trailing padding exercise the byte
        // boundary without allocating a 50-megapixel raster or a large fixture.
        source.append(Data(count: 50 * 1024 * 1024 - source.count))
        let prepared = try PhotoPipeline.prepare(source)
        XCTAssertEqual(prepared.width, 16)
        XCTAssertEqual(prepared.height, 12)
        XCTAssertLessThan(prepared.bytes.count, 20 * 1024 * 1024)
        let received = try ReceivedPhoto.decodeJPEG(prepared.bytes)
        XCTAssertEqual(received.image.width, 16)
        XCTAssertEqual(received.image.height, 12)

        source.append(0)
        XCTAssertThrowsError(try PhotoPipeline.prepare(source)) { error in
            XCTAssertEqual(error.localizedDescription,
                "Choose a photo that is 50 MB or smaller and no more than 40 megapixels.")
        }
    }
}

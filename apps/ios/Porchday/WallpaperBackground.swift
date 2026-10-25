import SwiftUI

/// Native drawings of the four original web SVG tiles. No network loading, animation or profile code.
struct WallpaperBackground: View {
    let wallpaper: ProfileWallpaper
    var body: some View {
        Canvas { context, size in
            guard wallpaper != .none else { return }
            let tile = tileSize
            for y in stride(from: CGFloat.zero, to: size.height, by: tile.height) {
                for x in stride(from: CGFloat.zero, to: size.width, by: tile.width) {
                    var cell = context
                    cell.translateBy(x: x, y: y)
                    cell.clip(to: Path(CGRect(origin: .zero, size: tile)))
                    draw(in: &cell)
                }
            }
        }.accessibilityHidden(true).allowsHitTesting(false)
    }
    private var tileSize: CGSize {
        switch wallpaper {
        case .porchStars: CGSize(width: 192, height: 152)
        case .orangeChecker: CGSize(width: 64, height: 64)
        case .sunnyDaisies: CGSize(width: 88, height: 88)
        case .midnightDiamonds: CGSize(width: 90, height: 92)
        case .none: CGSize(width: 1, height: 1)
        }
    }
    private func color(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }
    private func path(_ points: [(CGFloat, CGFloat)], closed: Bool = false) -> Path {
        Path { p in
            guard let first = points.first else { return }
            p.move(to: CGPoint(x: first.0, y: first.1))
            for point in points.dropFirst() { p.addLine(to: CGPoint(x: point.0, y: point.1)) }
            if closed { p.closeSubpath() }
        }
    }
    private func draw(in context: inout GraphicsContext) {
        func fill(_ points: [(CGFloat, CGFloat)], _ hex: UInt32) {
            context.fill(path(points, closed: true), with: .color(color(hex)))
        }
        func line(_ points: [(CGFloat, CGFloat)], _ hex: UInt32, _ width: CGFloat = 2, closed: Bool = false) {
            context.stroke(path(points, closed: closed), with: .color(color(hex)), lineWidth: width)
        }
        func rectangle(_ rect: CGRect, _ hex: UInt32) { context.fill(Path(rect), with: .color(color(hex))) }
        func cross(_ x: CGFloat, _ y: CGFloat, _ radius: CGFloat, _ hex: UInt32) {
            line([(x - radius, y), (x + radius, y)], hex)
            line([(x, y - radius), (x, y + radius)], hex)
        }
        switch wallpaper {
        case .none: break
        case .orangeChecker:
            rectangle(CGRect(origin: .zero, size: tileSize), 0xffedc8)
            rectangle(CGRect(x: 0, y: 0, width: 32, height: 32), 0xe79b4f)
            rectangle(CGRect(x: 32, y: 32, width: 32, height: 32), 0xe79b4f)
            line([(16, 8), (24, 16), (16, 24), (8, 16)], 0x8b421b, closed: true)
            line([(48, 40), (56, 48), (48, 56), (40, 48)], 0x8b421b, closed: true)
        case .sunnyDaisies:
            rectangle(CGRect(origin: .zero, size: tileSize), 0xffd67d)
            for rect in [CGRect(x: 19, y: 3, width: 12, height: 20), CGRect(x: 19, y: 27, width: 12, height: 20), CGRect(x: 3, y: 19, width: 20, height: 12), CGRect(x: 27, y: 19, width: 20, height: 12)] {
                let petal = Path(ellipseIn: rect)
                context.fill(petal, with: .color(color(0xfffaf0)))
                context.stroke(petal, with: .color(color(0xaa551f)), lineWidth: 2)
            }
            context.fill(Path(ellipseIn: CGRect(x: 17, y: 17, width: 16, height: 16)), with: .color(color(0xa74410)))
            line([(62, 56), (68, 63), (62, 70), (56, 63)], 0x92431c, closed: true)
            cross(16, 69, 4, 0x92431c); cross(71, 17, 4, 0x92431c)
        case .midnightDiamonds:
            rectangle(CGRect(origin: .zero, size: tileSize), 0x3a231c)
            for diamond in [[(CGFloat(25), CGFloat(10)), (38, 26), (25, 50), (12, 26)], [(68, 47), (79, 61), (68, 80), (57, 61)]] {
                fill(diamond, 0xffe8b0); line(diamond, 0xb96c3c, closed: true)
            }
            line([(12, 26), (38, 26)], 0x6a381b, 1)
            line([(25, 10), (20, 26), (25, 50), (30, 26)], 0x6a381b, 1, closed: true)
            line([(57, 71), (79, 71)], 0x6a381b, 1)
            line([(68, 47), (64, 61), (68, 80), (72, 61)], 0x6a381b, 1, closed: true)
            cross(66, 17, 5, 0xffd16d); cross(17, 71, 5, 0xffd16d)
        case .porchStars:
            rectangle(CGRect(origin: .zero, size: tileSize), 0x281b13)
            line([(0, 18), (192, 18)], 0x653919, 28); line([(0, 96), (192, 96)], 0x653919, 28)
            for x: CGFloat in [4, 26, 48, 70] { line([(x, 6), (x + 16, 18), (x, 30)], 0xdf762b, 8) }
            for x: CGFloat in [98, 120, 142, 164] { line([(x, 84), (x - 16, 96), (x, 108)], 0xdf762b, 8) }
            for star in [[(CGFloat(31), CGFloat(46)), (34, 56), (45, 56), (36, 62), (39, 72), (31, 66), (22, 72), (25, 62), (17, 56), (28, 56)], [(139, 36), (143, 49), (157, 49), (146, 57), (150, 70), (139, 62), (128, 70), (132, 57), (121, 49), (135, 49)], [(66, 121), (69, 130), (79, 130), (71, 136), (74, 145), (66, 140), (58, 145), (61, 136), (53, 130), (63, 130)]] {
                fill(star, 0xffd16d); line(star, 0x281b13, closed: true)
            }
            line([(92, 40), (100, 50), (92, 61), (84, 50)], 0xffecd1, closed: true)
            line([(164, 122), (173, 133), (164, 144), (155, 133)], 0xffecd1, closed: true)
            cross(13, 128, 5, 0xffecd1); cross(184, 52, 4.5, 0xffecd1)
        }
    }
}

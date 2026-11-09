import SwiftUI

/// Only an opaque background color crosses the bridge. Never snapshot page content.
@MainActor final class ShellAppearance: ObservableObject {
    static let shared = ShellAppearance()
    static let storageKey = "porchday.shell.background.v1"
    static let fallback = "#281b13"
    @Published private(set) var hex: String
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        hex = Self.validColor(defaults.string(forKey: Self.storageKey)) ?? Self.fallback
    }
    static func validColor(_ value: Any?) -> String? {
        guard let value = value as? String, value.utf8.count == 7, value.first == "#",
              value.dropFirst().allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return nil }
        return value.lowercased()
    }
    func update(_ value: Any?) -> Bool {
        guard let color = Self.validColor(value) else { return false }
        if hex != color { hex = color; defaults.set(color, forKey: Self.storageKey) }
        return true
    }
    private var components: (Double, Double, Double) {
        let rgb = UInt32(hex.dropFirst(), radix: 16) ?? 0x281b13
        return (Double((rgb >> 16) & 255) / 255, Double((rgb >> 8) & 255) / 255, Double(rgb & 255) / 255)
    }
    var background: Color {
        let (r, g, b) = components
        return Color(red: r, green: g, blue: b)
    }
    var foreground: Color {
        let (r, g, b) = components
        // Choose the higher-contrast label for either light or dark backgrounds.
        func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b) > 0.179 ? .black : .white
    }

    /// Installed at document end, before the page is backgrounded. Observe the
    /// actual preference application, including changes without localStorage.
    static let observerScript = """
    (() => {
      let previous = '';
      const publish = () => {
        const color = getComputedStyle(document.documentElement).getPropertyValue('--site-background-color').trim();
        if (!/^#[0-9a-f]{6}$/i.test(color) || color === previous) return;
        previous = color;
        window.webkit.messageHandlers.porchday.postMessage({version: 1, command: 'appearance', color}).catch(() => { previous = ''; });
      };
      new MutationObserver(publish).observe(document.documentElement, {attributes: true, attributeFilter: ['style', 'class', 'data-site-background']});
      publish();
      window.addEventListener('pageshow', publish);
    })();
    """
}

struct AppSwitcherCover: View {
    @ObservedObject private var appearance = ShellAppearance.shared
    var body: some View {
        appearance.background.ignoresSafeArea()
            .overlay { Text("Porchday").font(.largeTitle).foregroundStyle(appearance.foreground) }
            .accessibilityLabel("Porchday")
    }
}

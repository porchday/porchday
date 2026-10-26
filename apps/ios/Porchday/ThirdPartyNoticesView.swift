import SwiftUI

struct ThirdPartyNoticesView: View {
    private var notices: String {
        guard let url = Bundle.main.url(forResource: "ThirdPartyNotices", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return "License notices could not be loaded. They are available at porchday.org/third-party-notices.txt." }
        return text
    }
    var body: some View {
        ScrollView { Text(notices).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding() }
            .navigationTitle("Open source notices")
    }
}

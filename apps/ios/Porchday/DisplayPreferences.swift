import SwiftUI

enum DisplayPreferences {
    static func timeZone(_ identifier: String) -> TimeZone { TimeZone(identifier: identifier) ?? .current }
    static func date(_ date: Date) -> String {
        let formatter = DateFormatter(); formatter.dateStyle = .medium; formatter.timeStyle = .short
        formatter.timeZone = timeZone(UserDefaults.standard.string(forKey: "display-time-zone") ?? "")
        return formatter.string(from: date)
    }
}
struct DisplayPreferencesView: View {
    @AppStorage("display-color-scheme") private var scheme = "system"
    @AppStorage("display-time-zone") private var zone = ""
    var body: some View {
        Form {
            Picker("Appearance", selection: $scheme) { Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark") }
            Picker("Display time zone", selection: $zone) { Text("This device").tag(""); ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ")).tag($0) } }
            Text("These preferences apply on this device. Calendar days and custom expiration input use the device’s time zone. Changing display preferences never changes an expiration deadline.")
        }.navigationTitle("Display")
    }
}

import SwiftUI

/// Device-local presentation only; never changes signed timestamps or deadlines.
enum DisplayPreferences {
    static let colorKey = "porchday.color-scheme.v1"
    static let zoneKey = "porchday-timezone"
    static func colorScheme(_ value: String) -> ColorScheme? {
        switch value { case "light": .light; case "dark": .dark; default: nil }
    }
    static func timeZone(_ value: String) -> TimeZone {
        TimeZone(identifier: value) ?? .autoupdatingCurrent
    }
    static func date(_ value: Date, zone: String = UserDefaults.standard.string(forKey: zoneKey) ?? "") -> String {
        value.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: timeZone(zone)))
    }
}

struct DisplayPreferencesSection: View {
    @AppStorage(DisplayPreferences.colorKey) private var color = "system"
    @AppStorage(DisplayPreferences.zoneKey) private var zone = ""
    private var zones: [String] { Array(Set(TimeZone.knownTimeZoneIdentifiers + ["UTC", TimeZone.current.identifier])).sorted() }
    var body: some View {
        Section("Appearance and time") {
            Picker("Color scheme", selection: $color) {
                Text("Use system setting").tag("system")
                Text("Light").tag("light")
                Text("Dark").tag("dark")
            }
            Picker("Display timezone", selection: $zone) {
                Text("Use device timezone").tag("")
                ForEach(zones, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ")).tag($0) }
            }
            Text("These settings apply on this device. Deadlines remain the same instant for everyone. Custom expiration inputs use your device timezone.").font(.footnote)
            Text("Current time: " + DisplayPreferences.date(Date(), zone: zone)).font(.caption)
        }
    }
}

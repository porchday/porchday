import SwiftUI

struct ActivityAuthorView: View {
    let memberID: String
    let handle: String
    var created: Date? = nil
    var photoDay: String? = nil
    var sharing: String? = nil
    @EnvironmentObject var model: AppModel
    private var name: String { memberID == model.member?.id ? "@\(model.member?.handle ?? "")" : (handle.hasPrefix("@") ? handle : "@" + handle) }
    private var photoDate: Date? {
        guard let photoDay else { return nil }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: photoDay)
    }
    var body: some View {
        HStack(alignment: .top) {
            MemberAvatarView(memberID: memberID, name: name)
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(.headline)
                HStack(spacing: 4) {
                    if let date = photoDate { Text(date, style: .date).accessibilityLabel("Photo date: " + DisplayPreferences.date(date)) }
                    else if let created { Text(created, style: .relative) }
                    Image(systemName: "lock.fill").accessibilityLabel("End-to-end encrypted")
                    if let sharing { Text(sharing) }
                }.font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }
}

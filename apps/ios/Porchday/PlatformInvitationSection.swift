import SwiftUI

struct PlatformInvitationSection: View {
    @EnvironmentObject var model: AppModel
    @State private var email = ""
    @State private var sending = false
    @State private var notice: String?
    @State private var error: String?
    @AccessibilityFocusState private var feedbackFocused: Bool

    var body: some View {
        Section("Invite by email") {
            TextField("Email address", text: Binding(get: { email }, set: { email = $0; notice = nil; error = nil }))
                .keyboardType(.emailAddress).textContentType(.emailAddress)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityLabel("Invitation email address")
                .disabled(sending || !model.canWriteSocial)
            Button(sending ? "Requesting invitation…" : "Send invitation") { Task { await send() } }
                .disabled(sending || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.canWriteSocial)
            Text("For someone who hasn’t joined. Up to 10 requests every 24 hours. Invitations last seven days and work only for that email address. Joining does not create a friendship.")
                .font(.footnote).foregroundStyle(.secondary)
            if let notice { Text(notice).font(.callout).accessibilityFocused($feedbackFocused) }
            if let error { Text(error).font(.callout).foregroundStyle(.red).accessibilityFocused($feedbackFocused) }
        }
    }

    @MainActor private func send() async {
        guard !sending, let member = model.member else { return }
        sending = true; notice = nil; error = nil
        defer { sending = false }
        do {
            notice = try await PlatformInvitation.send(email: email, member: member) { path, body in
                try await model.api.social(path, method: "POST", body: body)
            }
            email = ""
        } catch { self.error = error.localizedDescription }
        feedbackFocused = true
    }
}

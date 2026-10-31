import SwiftUI

struct PlatformInvitationSection: View {
    @EnvironmentObject var model: AppModel
    @State private var email = ""
    @State private var kind = "friend"
    @State private var revoking: String?
    @State private var sending = false
    @State private var notice: String?
    @State private var error: String?
    @State private var invitations: [SentPlatformInvitation] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var loaded = false
    @State private var listError: String?
    @State private var readID = UUID()
    @AccessibilityFocusState private var feedbackFocused: Bool

    var body: some View {
        Section("Invite by email") {
            TextField("Email address", text: Binding(get: { email }, set: { email = $0; notice = nil; error = nil }))
                .keyboardType(.emailAddress).textContentType(.emailAddress)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityLabel("Invitation email address")
                .disabled(sending || !model.canWriteSocial)
            Picker("Connect as", selection: $kind) { Text("Friend").tag("friend"); Text("Family").tag("family") }.disabled(sending)
            Button(sending ? "Requesting invitation…" : "Send invitation") { Task { await send() } }
                .disabled(sending || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.canWriteSocial)
            Text("For someone who hasn’t joined. Up to 10 requests every 24 hours. Invitations last seven days and work only for that email address. Accepting and verifying their email connects you using the selected label, sharing future posts for that audience. Either person can change their own label or disconnect later.")
                .font(.footnote).foregroundStyle(.secondary)
            if let notice { Text(notice).font(.callout).accessibilityFocused($feedbackFocused) }
            if let error { Text(error).font(.callout).foregroundStyle(.red).accessibilityFocused($feedbackFocused) }
        }
        Section("Invitations") {
            Text("Last 90 days. Joined means they verified an account using your invitation.").font(.footnote).foregroundStyle(.secondary)
            if let listError { Text(listError).foregroundStyle(.red) }
            if loaded && invitations.isEmpty { Text("No invitations yet.") }
            ForEach(invitations) { invitation in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(invitation.email).font(.body)
                        Text("Requested " + invitation.requested.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                        if invitation.status == "pending" { Text("Expires " + invitation.expires.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    VStack { Text(invitation.statusLabel).font(.caption)
                        if let kind = invitation.kind { Text(kind == "family" ? "Family" : "Friend").font(.caption) }
                        if invitation.status == "pending" { Button("Revoke") { Task { await revoke(invitation) } }.disabled(revoking != nil) }
                    }
                }
            }
            if loading { ProgressView("Loading invitations…") }
            Button("Refresh invitations") { Task { await load() } }.disabled(loading)
            if cursor != nil { Button("Load more invitations") { Task { await load(more: true) } }.disabled(loading) }
        }.task(id: model.member?.id) { invitations = []; cursor = nil; loaded = false; await load() }
            .onDisappear { readID = UUID() }
    }

    @MainActor private func load(more: Bool = false) async {
        let attempt = UUID(), memberID = model.member?.id
        readID = attempt; loading = true; listError = nil
        defer { if readID == attempt { loading = false } }
        do {
            let result = try await model.api.social("/platform-invitations?v=2" + (more ? cursor.map { "&cursor=" + $0 } ?? "" : ""))
            guard readID == attempt, model.member?.id == memberID, !Task.isCancelled else { return }
            let rows = try result["items"].array.map(SentPlatformInvitation.init)
            invitations = more ? invitations + rows.filter { row in !invitations.contains { $0.id == row.id } } : rows
            cursor = result["next_cursor"].string; loaded = true
        } catch { if readID == attempt, model.member?.id == memberID, !Task.isCancelled { listError = "Could not load your invitations. Try again." } }
    }

    @MainActor private func revoke(_ invitation: SentPlatformInvitation) async {
        guard revoking == nil else { return }
        revoking = invitation.id
        defer { revoking = nil }
        do {
            _ = try await model.api.social("/platform-invitations/" + invitation.id + "/revoke", method: "POST")
            await load()
        } catch { listError = "Could not confirm revocation. Refresh invitations; if they already joined, manage the connection separately." }
    }

    @MainActor private func send() async {
        guard !sending, let member = model.member else { return }
        sending = true; notice = nil; error = nil
        defer { sending = false }
        do {
            let response = try await PlatformInvitation.send(email: email, member: member, kind: kind) { path, body in
                try await model.api.social(path, method: "POST", body: body)
            }
            guard model.member?.id == member.id, !Task.isCancelled else { return }
            notice = response; email = ""
            await load()
        } catch {
            guard model.member?.id == member.id, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
        feedbackFocused = true
    }
}

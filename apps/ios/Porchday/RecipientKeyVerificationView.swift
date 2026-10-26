import SwiftUI

struct RecipientKeyVerificationView: View {
    let recipient: VerificationRecipient
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @Environment(\.dismiss) private var dismiss
    @StateObject private var verification = RecipientKeyVerification()

    var body: some View {
        Form {
            Section {
                Text("Compare each full device ID and fingerprint with @\(recipient.handle) through a trusted channel, such as in person or a call you initiated. A new device has a different fingerprint.")
                Text("A first-seen key is not proof of identity or protection against a malicious key directory. This screen does not approve changed keys or add a device.").font(.footnote)
            }
            Section("Current encryption devices") {
                switch verification.status {
                case .idle, .loading:
                    ProgressView("Checking current keys…")
                case .available:
                    ForEach(verification.devices) { device in
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Device ID").font(.caption)
                            Text(device.id).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                            Text("Full fingerprint").font(.caption)
                            Text(device.fingerprint).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        }.padding(.vertical, 4)
                    }
                    Text("These are the keys returned for your current authorized audience. Refresh before comparing if the connection or their devices changed.").font(.footnote)
                case .unavailable:
                    Text("No current keys are available. The connection may no longer be available, or the person may have no active encryption devices. Revoked devices are not shown.")
                case .failed:
                    Text("Could not verify this person's current keys. Refresh to try again. Changed or mismatched fingerprints are not accepted.").foregroundStyle(.red)
                }
                Button("Refresh") { Task { await load() } }.disabled(verification.status == .loading)
            }
        }
        .navigationTitle("Verify @\(recipient.handle)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { Button("Done") { dismiss() } }
        .task(id: "\(model.member?.id ?? ""):\(recipient.id)") { await load() }
        .onDisappear { verification.cancel() }
    }

    private func load() async {
        await verification.load(memberID: recipient.id, ownMemberID: model.member?.id ?? "") {
            try await vault.audience("connections").1
        }
    }
}

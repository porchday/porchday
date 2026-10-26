import SwiftUI

struct AccountDeletionView: View {
    @EnvironmentObject var model: AppModel
    @AccessibilityFocusState private var headingFocused: Bool
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Account deletion accepted").font(.title2).accessibilityAddTraits(.isHeader).accessibilityFocused($headingFocused)
                    Text("Your deletion request was confirmed. Account access, sessions, and integration grants have been revoked.")
                    Text("Encrypted data and identity cleanup run in the background. Completion has not been verified on this screen.")
                    Text("Encrypted backups age out within seven days. Copies saved by you or other people cannot be recalled.")
                    Text(model.deletionClearingLocalData ? "Clearing this device’s keys and signing out…" : "You are signed out of this app. Device cleanup was requested; stored-key removal has not been independently verified.")
                    Text("This confirmation is kept only until you leave or close the app.").font(.footnote)
                    Button("Return to login") { model.deletionPhase = .idle }.disabled(model.deletionClearingLocalData)
                }
            }.navigationTitle("Account deletion").task { headingFocused = true }
        }
    }
}

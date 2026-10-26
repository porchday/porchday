import Foundation
import Combine

struct VerificationRecipient: Identifiable, Sendable {
    let id: String
    let handle: String
}

/// The directory is the current authorized connections audience, never a cached peer roster.
/// Cryptographic validation and pin checks remain the caller's CryptoVault responsibility.
@MainActor final class RecipientKeyVerification: ObservableObject {
    enum Status: Equatable { case idle, loading, available, unavailable, failed }
    @Published private(set) var status: Status = .idle
    @Published private(set) var devices: [Device] = []
    private var generation = UUID()

    func load(memberID: String, ownMemberID: String, audience: @MainActor () async throws -> [Device]) async {
        let attempt = UUID()
        generation = attempt; devices = []; status = .loading
        guard Self.isID(memberID), Self.isID(ownMemberID), memberID != ownMemberID else {
            status = .unavailable; return
        }
        do {
            let directory = try await audience()
            guard generation == attempt, !Task.isCancelled else { return }
            let selected = try Self.select(directory, memberID: memberID)
            devices = selected
            status = selected.isEmpty ? .unavailable : .available
        } catch {
            guard generation == attempt, !Task.isCancelled else { return }
            devices = []; status = .failed
        }
    }

    func cancel() {
        generation = UUID(); devices = []; status = .idle
    }

    private static func isID(_ value: String) -> Bool {
        UUID(uuidString: value)?.uuidString.lowercased() == value
    }

    private static func select(_ directory: [Device], memberID: String) throws -> [Device] {
        // A reused device identity across members is ambiguous even if its key parses.
        guard Set(directory.map(\.id)).count == directory.count else {
            throw PorchError.message("The device directory is inconsistent.")
        }
        let selected = directory.filter { $0.memberID == memberID && !$0.revoked }
        guard selected.allSatisfy({ device in
            isID(device.id) && device.fingerprint.utf8.count == 64 &&
                device.fingerprint.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        }) else { throw PorchError.message("A device identity is incomplete.") }
        return selected.sorted { $0.id < $1.id }
    }
}

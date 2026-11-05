import Foundation

/// A fresh authenticated response, never a persisted device-roster cache.
struct NativeMemberBootstrap {
    let member: Member
    let devices: [JSON]?

    @MainActor static func fetch(request: (String) async throws -> JSON) async throws -> NativeMemberBootstrap {
        let raw = try await request("/me?bootstrap=1")
        let member = try Member(raw)
        let devices: [JSON]?
        switch raw["startup_devices"] {
        case .null: devices = nil // Older servers require a fresh /devices read.
        case .array(let rows): devices = rows
        default: throw PorchError.message("The authorized device roster is unavailable.")
        }
        return NativeMemberBootstrap(member: member, devices: devices)
    }

    static func isSignedOut(_ error: Error) -> Bool {
        if case PorchError.api(let code, _, _) = error { return code == "UNAUTHORIZED" }
        return false
    }
}

import Foundation

/// Stage only the reviewed surface slots; the API commits their removal with
/// the revised encrypted payload and records ciphertext cleanup atomically.
struct SurfacePhotoRemoval {
    let payload: JSON
    let removals: JSON

    init(payload: JSON, slots: [String], removed: Set<String>, replaced: Set<String> = []) {
        var next = payload.object
        var requests: [JSON] = []
        for slot in slots where removed.contains(slot) && !replaced.contains(slot) {
            if let id = next[slot]?["id"].string {
                requests.append(.object(["id": .string(id), "slot": .string(slot)]))
            }
            next.removeValue(forKey: slot)
        }
        self.payload = .object(next)
        removals = .array(requests)
    }
}

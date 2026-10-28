import Foundation

enum ProfileVisibility {
    static func read(_ context: JSON) throws -> String {
        if context == .null { return "connections" }
        guard let audience = context["audience"].string, ["connections", "only_me"].contains(audience) else {
            throw PorchError.message("This profile visibility is not supported by this version. Update Porchday before editing it.")
        }
        return audience
    }
}

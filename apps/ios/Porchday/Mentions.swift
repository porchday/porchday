import Foundation

/// Resolve only exact handles in the authorized local directory. A mention adds
/// encrypted identity metadata, never recipients or an out-of-band notification.
enum NativeMentions {
    static func resolve(_ text: String, directory: [PersonTag], existing: [PersonTag]) -> [PersonTag] {
        guard let expression = try? NSRegularExpression(pattern: #"(?<![\p{L}\p{N}_@])@([A-Za-z0-9_]+)(?![\p{L}\p{N}_])"#) else { return existing }
        let ns = text as NSString
        var result = existing
        for match in expression.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let handle = ns.substring(with: match.range(at: 1)).lowercased()
            if result.count < 30, let person = directory.first(where: { $0.kind == "member" && $0.label.lowercased() == handle }), !result.contains(where: { $0.id == person.id }) { result.append(person) }
        }
        return result
    }
}

import SwiftUI
import CoreImage.CIFilterBuiltins

struct AccountSecurityView: View {
    @EnvironmentObject var model: AppModel
    @State private var enabled: Bool?
    @State private var password = ""
    @State private var email = ""
    @State private var setup: JSON?
    @State private var code = ""
    @State private var saved = false
    @State private var busy = false
    @State private var notice = ""
    var body: some View {
        Form {
            Section("Sign-in email") {
                Text("Changing email requires recent sign-in, approval from your current verified address, and verification of the new address. Completed changes sign out existing sessions.")
                TextField("New email", text: $email).porchKeyboard(.emailAddress).porchCapitalization(.never)
                Button("Request email change") { Task { await run {
                    _ = try await model.api.auth("change-email", body: .object(["newEmail": .string(email), "callbackURL": .string(ServerConfiguration.origin.absoluteString + "/login?emailChanged=1")]))
                    email = ""; notice = "Check your current email to approve the change, then verify the new address."
                } } }.disabled(busy || email.isEmpty)
            }
            Section("Two-factor authentication") {
                Text("This protects sign-in. It does not replace your encryption recovery secret.")
                if let setup {
                    if let image = qr(setup["totpURI"].string ?? "") { Image(platformImage: image).interpolation(.none).resizable().frame(width: 220, height: 220).accessibilityLabel("Authenticator setup QR code").privacySensitive() }
                    let secret = URLComponents(string: setup["totpURI"].string ?? "")?.queryItems?.first { $0.name == "secret" }?.value ?? ""
                    Text("Manual authenticator key"); Text(secret).textSelection(.enabled).privacySensitive()
                    Text("Time-based, 6 digits, every 30 seconds.").font(.caption)
                    Text("One-time backup codes").font(.headline)
                    Text(setup["backupCodes"].array.compactMap(\.string).joined(separator: "\n")).textSelection(.enabled).privacySensitive()
                    Toggle("I saved these backup codes somewhere safe and separate from this device", isOn: $saved)
                    SecureField("Authenticator code", text: $code).porchContentType(.oneTimeCode)
                    Button("Verify and enable") { Task { await run {
                        _ = try await model.api.auth("two-factor/verify-totp", body: .object(["code": .string(code), "trustDevice": .bool(false)])); self.setup = nil; code = ""; enabled = true; notice = "Two-factor authentication is enabled."
                    } } }.disabled(busy || !saved || code.count != 6)
                } else if let enabled {
                    Text(enabled ? "Enabled" : "Not enabled")
                    SecureField("Current password", text: $password).porchContentType(.password)
                    Button(enabled ? "Disable two-factor authentication" : "Set up authenticator") { Task { await run {
                        if enabled { _ = try await model.api.auth("two-factor/disable", body: .object(["password": .string(password)])); self.enabled = false; notice = "Two-factor authentication disabled." }
                        else { setup = try await model.api.auth("two-factor/enable", body: .object(["password": .string(password)])); saved = false }
                        password = ""
                    } } }.disabled(busy || password.isEmpty)
                } else { Button("Load security status") { Task { await load() } } }
            }
            if !notice.isEmpty { Text(notice) }
        }.navigationTitle("Account security").task { await load() }
        .onDisappear { password = ""; code = ""; setup = nil }
    }
    private func run(_ action: () async throws -> Void) async { busy = true; defer { busy = false }; await model.perform(action) }
    private func load() async { await run { let session = try await model.api.auth("get-session", method: "GET"); enabled = session["user"]["twoFactorEnabled"].boolean } }
    private func qr(_ value: String) -> PlatformImage? {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(value.utf8); filter.correctionLevel = "M"
        guard let result = filter.outputImage, let image = CIContext().createCGImage(result, from: result.extent) else { return nil }; return PlatformImage(cgImage: image)
    }
}
struct AppealsView: View {
    @EnvironmentObject var model: AppModel
    @State private var rows: [JSON] = []
    @State private var loaded = false
    @State private var busy = false
    @State private var notice = ""
    var body: some View {
        List {
            Text("Ask an independent moderator to reconsider an account decision. A security hold uses the separate stolen-account process.")
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading) {
                    Text(row["action"].string ?? "Account action"); Text(row["reason_code"].string ?? "Review required").font(.caption)
                    Button("Request review") { Task { busy = true; defer { busy = false }; await model.perform { _ = try await model.api.request("/api/member-appeals", method: "POST", body: .object(["action_id": row["id"]])); notice = "Independent review requested."; await load() } } }.disabled(busy)
                }
            }
            if loaded && rows.isEmpty { Text("No eligible account decisions.") }
            Text(notice)
            NavigationLink("Report a stolen account") { StolenAccountView() }
        }.navigationTitle("Appeals").task { await load() }.refreshable { await load() }
    }
    private func load() async { await model.perform { rows = try await model.api.request("/api/member-appeals")["items"].array; loaded = true } }
}
struct RegisterIntegrationView: View {
    @EnvironmentObject var model: AppModel
    @State private var name = ""
    @State private var purpose = ""
    @State private var redirect = ""
    @State private var result = ""
    @State private var busy = false
    var body: some View {
        Form {
            Text("Register a data transport tool you are building. Tools may access only your ciphertext and routing metadata, never keys or permission to act as a member. Autonomous social actions are not permitted.")
            TextField("App name", text: $name); TextField("Purpose", text: $purpose); TextField("Return address", text: $redirect).porchCapitalization(.never)
            Button("Register tool") { Task { busy = true; defer { busy = false }; await model.perform { let response = try await model.api.social("/integrations/clients", method: "POST", body: .object(["name": .string(name), "purpose": .string(purpose), "redirect_uri": .string(redirect)])); result = response["id"].string ?? "" } } }.disabled(busy || name.isEmpty || name.count > 100 || purpose.isEmpty || purpose.count > 500 || redirect.isEmpty)
            if !result.isEmpty { Text("Registered client ID"); Text(result).textSelection(.enabled); Text("Use authorization code with PKCE S256 and explicit member consent.") }
            NavigationLink("Review an authorization link") { IntegrationConsentView() }
        }.navigationTitle("Integrations")
    }
}
struct IntegrationConsentView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openURL) private var openURL
    @State private var link = ""
    @State private var client: JSON?
    @State private var parameters: [String: String] = [:]
    @State private var busy = false
    private let allowed = ["emoji:read", "profile:read", "content:read", "media:read", "export:read"]
    var body: some View {
        Form {
            TextField("Paste authorization link", text: $link).porchCapitalization(.never).onChange(of: link) { _, _ in client = nil }
            Button("Review request") { Task { await review() } }.disabled(busy || link.isEmpty)
            if let client {
                Text(client["name"].string ?? "Tool").font(.headline); Text(client["purpose"].string ?? "")
                Text("Requested scopes: " + (parameters["scope"] ?? "")); Text("Return address: " + (client["redirect_uri"].string ?? ""))
                Text("Shares only your own ciphertext and necessary metadata. No keys, friends’ feed, or posting permission. Grants expire after 30 days; revocation cannot recall copies already received.")
                Button("Allow selected access") { Task { busy = true; defer { busy = false }; await model.perform {
                    let response = try await model.api.social("/integrations/authorize", method: "POST", body: .object(["client_id": .string(parameters["client_id"]!), "redirect_uri": client["redirect_uri"], "scope": .array((parameters["scope"] ?? "").split(whereSeparator: \.isWhitespace).map { .string(String($0)) }), "code_challenge": .string(parameters["code_challenge"]!), "code_challenge_method": .string("S256"), "state": .string(parameters["state"]!), "consent": .bool(true)]))
                    guard let target = response["redirect_uri"].string.flatMap(URL.init(string:)), let registered = client["redirect_uri"].string.flatMap(URL.init(string:)), target.scheme == registered.scheme, target.host == registered.host, target.port == registered.port, target.path == registered.path, target.user == nil, target.password == nil else { throw PorchError.message("The return address did not match.") }
                    self.client = nil; openURL(target)
                } } }.disabled(busy)
            }
        }.navigationTitle("Connect a tool?")
    }
    private func review() async {
        busy = true; client = nil; defer { busy = false }
        await model.perform {
            guard let url = URL(string: link), ServerConfiguration.permits(url, origin: ServerConfiguration.origin), let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw PorchError.message("Use a Porchday authorization URL.") }
            var q: [String: String] = [:]
            for item in components.queryItems ?? [] { guard q[item.name] == nil else { throw PorchError.message("Duplicate authorization parameter.") }; q[item.name] = item.value }
            guard let id = q["client_id"], UUID(uuidString: id) != nil, let scope = q["scope"], !scope.isEmpty, scope.split(whereSeparator: \.isWhitespace).allSatisfy({ allowed.contains(String($0)) }), q["code_challenge_method"] == "S256", !(q["state"] ?? "").isEmpty, !(q["code_challenge"] ?? "").isEmpty else { throw PorchError.message("Unsupported authorization request.") }
            let result = try await model.api.social("/integrations/clients/" + id)
            guard result["redirect_uri"].string == q["redirect_uri"] else { throw PorchError.message("The return address does not match the registered tool.") }
            parameters = q; client = result
        }
    }
}

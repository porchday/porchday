import Foundation
func check(_ value: Bool, _ label: String) { if !value { fatalError(label) } }
check(NavigationPolicy.isInternal(NavigationPolicy.home), "Home must remain internal")
check(NavigationPolicy.isInternal(URL(string: "https://porchday.org/login?verified=1")!), "Login callback")
for raw in ["https://porchday.org.evil.test/app", "http://porchday.org/app", "https://porchday.org:444/app", "https://user@porchday.org/app", "file:///tmp/file", "javascript:alert(1)", "https://porchday.com/app"] {
 check(!NavigationPolicy.isInternal(URL(string: raw)!), "Rejected internal origin: " + raw)
}
for raw in ["file:///tmp/file", "javascript:alert(1)", "data:text/html,test", "custom:command", "https://user:password@example.test/"] {
 check(!NavigationPolicy.canOpenExternally(URL(string: raw)!), "Rejected external scheme: " + raw)
}
check(NavigationPolicy.canOpenExternally(URL(string: "https://example.test/")!), "External HTTPS")
check(NavigationPolicy.canOpenExternally(URL(string: "mailto:hello@example.test")!), "Email link")
print("PASS: navigation policy")

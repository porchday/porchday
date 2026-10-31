import XCTest
final class OnboardingTests:XCTestCase {
    @MainActor private func openApp()->XCUIApplication {
        let app=XCUIApplication();app.launchArguments=["--ui-testing"];app.launch()
        XCTAssertTrue(app.staticTexts["a simple social network"].waitForExistence(timeout:10));return app
    }
    @MainActor private func tapVisible(_ element:XCUIElement,in app:XCUIApplication) {
        for _ in 0..<5 { if element.exists && element.isHittable { break };app.swipeUp() }
        XCTAssertTrue(element.exists);XCTAssertTrue(element.isHittable);element.tap()
    }
    @MainActor func testInvitationRequiresAdultAttestation() {
        let app=openApp();XCTAssertTrue(app.buttons["Log in"].exists)
        tapVisible(app.buttons["toggle-signup"],in:app)
        XCTAssertTrue(app.switches["I am at least 18 years old"].waitForExistence(timeout:5))
        let createAccount=app.buttons["Create account"]
        // Form rows below the connection disclosure may not exist until scrolled into view.
        for _ in 0..<5 { if createAccount.exists { break };app.swipeUp() }
        XCTAssertTrue(createAccount.exists);XCTAssertFalse(createAccount.isEnabled)
    }
    @MainActor func testStolenAccountReportAvailableWithoutLogin() {
        let app=openApp();tapVisible(app.buttons["report-stolen-account"],in:app)
        XCTAssertTrue(app.navigationBars["Account stolen?"].waitForExistence(timeout:5))
        XCTAssertTrue(app.textFields["Safe contact email"].exists)
        let screenshot=XCTAttachment(screenshot:app.screenshot());screenshot.name="Native recovery entry";screenshot.lifetime = .keepAlways;add(screenshot)
    }
}

import XCTest
final class OnboardingTests:XCTestCase {
    @MainActor func testWelcomeInvitationAndStolenAccountEntryPoints() {
        let app=XCUIApplication();app.launchArguments=["--ui-testing"];app.launch()
        XCTAssertTrue(app.staticTexts["a late 90s style social network"].waitForExistence(timeout:10))
        XCTAssertTrue(app.buttons["Log in"].exists)
        app.buttons["I have an invitation"].tap()
        XCTAssertTrue(app.switches["I am at least 18 years old"].exists)
        XCTAssertTrue(app.buttons["Create account"].exists)
        app.buttons["I already have an account"].tap()
        app.buttons["My account was stolen"].tap()
        XCTAssertTrue(app.navigationBars["Account stolen?"].waitForExistence(timeout:5))
        let screenshot=XCTAttachment(screenshot:app.screenshot());screenshot.name="Native recovery entry";screenshot.lifetime = .keepAlways;add(screenshot)
    }
}

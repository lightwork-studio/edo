import XCTest

final class OfflineSmokeUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "studio.lightwork.edo")

    func testApprovedDesignAndOfflineDiary() throws {
        continueAfterFailure = false
        launch(language: "en", locale: "en_US")
        _ = try element("Nothing logged yet")
        snapshot("Today and bottom tabs")

        try element("Foods", tappable: true).tap()
        _ = try element("No custom foods yet.")
        try element("Profile", tappable: true).tap()
        _ = try element("Diary files")
        _ = try element("Targets")
        snapshot("Profile")
        try element("Progress", tappable: true).tap()
        _ = try element("Add weight")
        try element("Log", tappable: true).tap()
        _ = try field("Search by food name")
        try element("Back", tappable: true).tap()
        _ = try element("Add weight")

        try element("Today", tappable: true).tap()
        try element("Log", tappable: true).tap()
        let english = try field("Search by food name")
        english.tap()
        try type("apple", in: english)
        try element("Clear search", tappable: true).tap()
        try type("bananennektar", in: english)
        let submitSearch = app.keyboards.buttons["Search"].firstMatch
        if submitSearch.exists && submitSearch.isHittable {
            submitSearch.tap()
        }
        let banana = try element("Banana nectar", contains: true, tappable: true)
        snapshot("Add Food catalog")
        banana.tap()
        try element("50 g", tappable: true).tap()
        snapshot("Selected offline portion")
        try element("Add to diary", tappable: true).tap()
        try verifySavedMeal()

        app.terminate()
        app.launch()
        try verifySavedMeal()
        snapshot("Today with saved meal after restart")

        app.terminate()
        launch(language: "de", locale: "de_DE")
        try element("Erfassen", tappable: true).tap()
        let german = try field("Lebensmittel suchen")
        german.tap()
        try type("banana nectar", in: german)
        _ = try element("Bananennektar", contains: true)
        snapshot("Lebensmittel suchen")
        print("Verified the five-tab bar, return from Log, Clear focus and bilingual offline search, and saved diary relaunch.")
    }

    private func launch(language: String, locale: String) {
        app.launchArguments = ["-AppleLanguages", "(\(language))", "-AppleLocale", locale]
        app.launch()
    }

    private func field(_ label: String) throws -> XCUIElement {
        let predicate = NSPredicate(format: "placeholderValue == %@ OR label == %@", label, label)
        let input = app.textFields.matching(predicate).firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 20), app.debugDescription)
        return input
    }

    private func type(_ query: String, in input: XCUIElement) throws {
        var typed = ""
        for character in query {
            input.typeText(String(character))
            typed.append(character)
            let deadline = Date().addingTimeInterval(20)
            var observed = input.value as? String
            while observed != typed && Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.25))
                observed = input.value as? String
            }
            XCTAssertEqual(observed, typed, app.debugDescription)
        }
    }

    private func verifySavedMeal() throws {
        _ = try element("Banana nectar", contains: true)
        _ = try element("50 g", contains: true)
        _ = try element("26 kcal", contains: true)
    }

    private func snapshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func element(
        _ expected: String, contains: Bool = false, tappable: Bool = false
    ) throws -> XCUIElement {
        let predicate = contains
            ? NSPredicate(format: "label CONTAINS[c] %@", expected)
            : NSPredicate(format: "label == %@ OR identifier == %@", expected, expected)
        let deadline = Date().addingTimeInterval(25)
        repeat {
            let buttons = tappable ? app.buttons.matching(predicate).allElementsBoundByIndex : []
            let descendants = app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex
            for candidate in buttons + descendants where candidate.exists {
                if !tappable || (candidate.isHittable && candidate.isEnabled) {
                    return candidate
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        return try XCTUnwrap(nil, "Expected \(expected). Accessibility hierarchy:\n\(app.debugDescription)")
    }
}

import XCTest

final class OfflineSmokeUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "studio.lightwork.edo")

    func testBundledDiaryAndBilingualSearch() throws {
        continueAfterFailure = false
        launch(language: "en", locale: "en_US")
        _ = try label("Nothing logged yet")
        try search(add: "Add food", field: "Search foods by name", query: "Bananennektar")
        try label("Banana nectar", contains: true, tappable: true).tap()
        try label("50 g", tappable: true).tap()
        try label("Add to diary", tappable: true).tap()
        try verifyMeal()
        print("Fresh iOS install found the bundled food in English and logged 50 g at 26 kcal")

        app.terminate()
        app.launch()
        try verifyMeal()
        print("iOS diary retained the portion and calories after a full app restart")

        app.terminate()
        launch(language: "de", locale: "de_DE")
        try search(add: "Lebensmittel hinzufügen", field: "Lebensmittel nach Name suchen", query: "Banana nectar")
        _ = try label("Bananennektar", contains: true)
        print("German iOS app locale found the bundled food from its English name")
    }

    private func launch(language: String, locale: String) {
        app.launchArguments = ["-AppleLanguages", "(\(language))", "-AppleLocale", locale]
        app.launch()
    }

    private func search(add: String, field: String, query: String) throws {
        try label(add, contains: true, tappable: true).tap()
        let fields = app.textFields.matching(NSPredicate(format: "placeholderValue == %@ OR label == %@ OR identifier == %@", field, field, field))
        let input = fields.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 20), app.debugDescription)
        input.tap()
        input.typeText(query)
    }

    private func verifyMeal() throws {
        _ = try label("Banana nectar", contains: true)
        _ = try label("50 g", contains: true)
        _ = try label("26 kcal", contains: true)
    }

    private func label(_ expected: String, contains: Bool = false, tappable: Bool = false) throws -> XCUIElement {
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

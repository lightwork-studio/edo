import XCTest

final class OfflineSmokeUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "studio.lightwork.edo")

    override func setUpWithError() throws {
        continueAfterFailure = false
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    }

    func testPrimeOnline() throws {
        app.launch()
        _ = try label("Nothing logged yet")
        try scan("3017620422003")
        try label("Nutella", contains: true, tappable: true).tap()
        try label("100 g", tappable: true).tap()
        try label("Add to diary", tappable: true).tap()
        _ = try label("Nutella", contains: true)
        _ = try label("539 kcal", contains: true)

        try scan("4000417025005")
        try label("Marzipan", contains: true, tappable: true).tap()
        try label("to favorites", contains: true, tappable: true).tap()
        _ = try label("from favorites", contains: true)
        print("Primed separate logged and favorited products through the public catalog")
    }

    func testCatalogOutage() throws {
        app.launch()
        try verifyCache()
        app.terminate()
        app.launch()
        try verifyCache()
        print("The two cached products and unrecognized barcode fallback survived a full process restart")
    }

    private func verifyCache() throws {
        _ = try label("539 kcal", contains: true)
        try scan("3017620422003")
        _ = try label("Saved on this device")
        _ = try label("Nutella", contains: true)
        try back(2)

        try label("Add food", contains: true, tappable: true).tap()
        try label("My Foods", tappable: true).tap()
        _ = try label("Favorites")
        try label("Marzipan", contains: true, tappable: true).tap()
        _ = try label("Open Food Facts contributors", contains: true)
        _ = try label("from favorites", contains: true)
        try back(3)

        try scan("5449000000996")
        _ = try label("Product lookup is unavailable", contains: true)
        try label("Search foods by name", tappable: true).tap()
        let query = try field("Search foods by name")
        try type("Nutella", into: query)
        try label("Nutella", contains: true, tappable: true).tap()
        _ = try label("Open Food Facts contributors", contains: true)
        try back(2)
    }

    private func scan(_ barcode: String) throws {
        try label("Add food", contains: true, tappable: true).tap()
        try label("Scan barcode", tappable: true).tap()
        try type(barcode, into: field("Product barcode"))
        try label("Find product", tappable: true).tap()
    }

    private func field(_ expected: String) throws -> XCUIElement {
        let query = app.textFields.matching(NSPredicate(
            format: "placeholderValue == %@ OR label == %@ OR identifier == %@",
            expected, expected, expected
        )).firstMatch
        XCTAssertTrue(query.waitForExistence(timeout: 20), app.debugDescription)
        return query
    }

    private func type(_ text: String, into input: XCUIElement) throws {
        input.tap()
        var entered = ""
        for character in text {
            input.typeText(String(character))
            entered.append(character)
            let deadline = Date().addingTimeInterval(12)
            var observed = String(describing: input.value ?? "")
            while observed != entered && Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.25))
                observed = String(describing: input.value ?? "")
            }
            XCTAssertEqual(observed, entered, app.debugDescription)
        }
    }

    private func back(_ count: Int) throws {
        for _ in 0..<count {
            try label("Back", tappable: true).tap()
        }
    }

    private func label(
        _ expected: String,
        contains: Bool = false,
        tappable: Bool = false
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

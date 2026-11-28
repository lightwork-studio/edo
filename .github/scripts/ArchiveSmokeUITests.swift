import XCTest

final class ArchiveSmokeUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "studio.lightwork.edo")

    private func launchDiaryFiles() throws {
        continueAfterFailure = false
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        try openDiaryFiles()
    }

    func testCancellationReturnsToDiaryFiles() throws {
        try launchDiaryFiles()
        try tap("Choose archive", in: [app])
        try tapPicker("Cancel")
        if element(["Choose archive"], in: [app], timeout: 2, hittable: true) == nil {
            // The system sheet also supports an interactive dismissal from its top edge.
            let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.09))
            let below = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65))
            top.press(forDuration: 0.1, thenDragTo: below)
        }
        _ = try locate(["Choose archive"], in: [app], hittable: true)
        XCTAssertFalse(app.buttons["Cancel"].exists)
        print("Cancelled the iOS picker and returned to Diary files")
    }

    private func exportFixturesToFiles() throws {
        let exporter = XCUIApplication(bundleIdentifier: "studio.lightwork.edo.smoke-fixtures")
        exporter.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        exporter.launch()
        try tap("Export fixtures", in: [exporter])
        if element(["On My iPhone"], in: [exporter], timeout: 4, hittable: false, picker: true) == nil {
            let browse = try locate(["Browse", "Locations"], in: [exporter], hittable: false, picker: true)
            tapPickerElement(browse)
        }
        let local = try locate(["On My iPhone"], in: [exporter], hittable: false, picker: true)
        tapPickerElement(local)
        let save = exporter.buttons["Save"].firstMatch
        XCTAssertTrue(save.waitForExistence(timeout: 20), exporter.debugDescription)
        tapPickerElement(save)
        try waitFor("Exported four fixtures", in: [exporter])
        print("Saved the synthetic archives through the iOS export picker")
    }

    func testArchiveRestoreThroughFiles() throws {
        continueAfterFailure = false
        try exportFixturesToFiles()
        try launchDiaryFiles()
        try chooseArchive("Edo-valid-smoke")
        try waitFor("1 new · 0 already saved", in: [app])
        try tap("Restore records", in: [app])
        try waitFor("1 restored · 0 already saved", in: [app])
        print("Confirmed and restored a synthetic weigh-in through Files")

        app.terminate()
        app.launch()
        try openDiaryFiles()
        try chooseArchive("Edo-valid-smoke")
        try waitFor("0 new · 1 already saved", in: [app])
        XCTAssertFalse(app.buttons["Restore records"].exists)
        print("Reopened Edo and verified the restored record persisted")

        try chooseArchive("Edo-conflict-smoke")
        try waitFor("This archive has 1 invalid or conflicting records.", in: [app])
        XCTAssertFalse(app.buttons["Restore records"].exists)
        try chooseArchive("Edo-malformed-smoke")
        try waitFor("Couldn’t open this Edo diary archive.", in: [app])
        XCTAssertFalse(app.buttons["Restore records"].exists)
        try chooseArchive("Edo-oversized-smoke")
        try waitFor("Restore on this phone supports archives up to 16 MiB.", in: [app])
        XCTAssertFalse(app.buttons["Restore records"].exists)
        print("Rejected a conflicting record, trailing NUL content and an oversized archive")
    }

    private func openDiaryFiles() throws {
        try tap("Progress", in: [app])
        try tap("Diary files", in: [app])
    }

    private func chooseArchive(_ name: String) throws {
        try tap("Choose archive", in: [app])
        // Files exposes the tappable item as a cell whose identifier includes the type.
        let fileNames = [name + ".json, json", name + ", json"]
        if let archive = element(fileNames, in: [app], timeout: 3, hittable: false, picker: true) {
            tapPickerElement(archive, at: 0.28)
            return
        }
        if element(["On My iPhone"], in: [app], timeout: 2, hittable: false, picker: true) == nil {
            // The picker may initially show Recents or an iCloud Drive folder.
            try tapPicker("Browse")
        }
        if let archive = element(fileNames, in: [app], timeout: 3, hittable: false, picker: true) {
            tapPickerElement(archive, at: 0.28)
            return
        }
        try tapPicker("On My iPhone")
        tapPickerElement(try locate(fileNames, in: [app], hittable: false, picker: true), at: 0.28)
    }

    private func tapPicker(_ label: String) throws {
        tapPickerElement(try locate([label], in: [app], hittable: false, picker: true))
    }

    private func tapPickerElement(_ element: XCUIElement, at verticalOffset: CGFloat = 0.5) {
        // A coordinate anchored to the remote control can tap its visible content.
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: verticalOffset)).tap()
    }

    private func tap(_ label: String, in applications: [XCUIApplication]) throws {
        try locate([label], in: applications, hittable: true).tap()
    }

    private func waitFor(_ label: String, in applications: [XCUIApplication]) throws {
        _ = try locate([label], in: applications, hittable: false)
    }

    private func locate(
        _ labels: [String], in applications: [XCUIApplication], hittable: Bool,
        picker: Bool = false
    ) throws -> XCUIElement {
        let match = element(labels, in: applications, timeout: 25, hittable: hittable, picker: picker)
        let hierarchy = match == nil ? applications.map(\.debugDescription).joined(separator: "\n") : ""
        return try XCTUnwrap(match, "Expected \(labels). Accessibility hierarchy:\n\(hierarchy)")
    }

    private func element(
        _ labels: [String], in applications: [XCUIApplication], timeout: TimeInterval,
        hittable: Bool, picker: Bool = false
    ) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            for application in applications {
                for label in labels {
                    let predicate = NSPredicate(format: "label == %@ OR identifier == %@", label, label)
                    let matches = application.descendants(matching: .any).matching(predicate)
                    let candidates = picker
                        ? application.buttons.matching(predicate).allElementsBoundByIndex + matches.allElementsBoundByIndex
                        : matches.allElementsBoundByIndex
                    for match in candidates {
                        guard match.exists else { continue }
                        if picker {
                            let frame = match.frame
                            guard !frame.isEmpty,
                                  application.frame.contains(CGPoint(x: frame.midX, y: frame.midY))
                            else { continue }
                        } else if hittable && (!match.isHittable || !match.isEnabled) {
                            continue
                        }
                        return match
                    }
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        return nil
    }
}

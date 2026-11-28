import XCTest

final class ArchiveSmokeUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "studio.lightwork.edo")

    func testArchiveRestoreThroughFiles() throws {
        continueAfterFailure = false
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        try openDiaryFiles()

        try tap("Choose archive", in: [app])
        try tapPicker("Cancel")
        try waitFor("Share diary archive", in: [app])
        print("Cancelled the iOS picker and returned to Diary files")

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
        let fileNames = [name, name + ".json"]
        if let archive = element(fileNames, in: [app], timeout: 3, hittable: false, picker: true) {
            tapPickerElement(archive)
            return
        }
        if element(["On My iPhone"], in: [app], timeout: 2, hittable: false, picker: true) == nil {
            // The picker may initially show Recents or an iCloud Drive folder.
            try tapPicker("Browse")
        }
        if element(["Archive Fixtures"], in: [app], timeout: 2, hittable: false, picker: true) == nil {
            try tapPicker("On My iPhone")
        }
        if let archive = element(fileNames, in: [app], timeout: 3, hittable: false, picker: true) {
            tapPickerElement(archive)
            return
        }
        try tapPicker("Archive Fixtures")
        tapPickerElement(try locate(fileNames, in: [app], hittable: false, picker: true))
    }

    private func tapPicker(_ label: String) throws {
        tapPickerElement(try locate([label], in: [app], hittable: false, picker: true))
    }

    private func tapPickerElement(_ element: XCUIElement) {
        // The remote view exposes the rendered frame even when XCTest cannot hit-test it.
        let frame = element.frame
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: frame.midX, dy: frame.midY)).tap()
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
                    for match in matches.allElementsBoundByIndex {
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

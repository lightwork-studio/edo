import XCTest

final class ArchiveSmokeUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "studio.lightwork.edo")

    func testArchiveRestoreThroughFiles() throws {
        continueAfterFailure = false
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        try openDiaryFiles()

        try tap("Choose archive", in: [app])
        try tap("Cancel", in: [app])
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
        // The document picker is presented inside Edo. The standalone Files app need not run.
        let providers = [app]
        let fileNames = [name, name + ".json"]
        if let archive = element(fileNames, in: providers, timeout: 3, hittable: true) {
            archive.tap()
            return
        }
        if element(["On My iPhone"], in: providers, timeout: 2, hittable: true) == nil {
            // The picker may initially show Recents or an iCloud Drive folder.
            try tap("Browse", in: providers)
        }
        if element(["Archive Fixtures"], in: providers, timeout: 2, hittable: true) == nil {
            try tap("On My iPhone", in: providers)
        }
        if let archive = element(fileNames, in: providers, timeout: 3, hittable: true) {
            archive.tap()
            return
        }
        try tap("Archive Fixtures", in: providers)
        try locate(fileNames, in: providers, hittable: true).tap()
    }

    private func tap(_ label: String, in applications: [XCUIApplication]) throws {
        try locate([label], in: applications, hittable: true).tap()
    }

    private func waitFor(_ label: String, in applications: [XCUIApplication]) throws {
        _ = try locate([label], in: applications, hittable: false)
    }

    private func locate(
        _ labels: [String], in applications: [XCUIApplication], hittable: Bool
    ) throws -> XCUIElement {
        let match = element(labels, in: applications, timeout: 25, hittable: hittable)
        let hierarchy = match == nil ? applications.map(\.debugDescription).joined(separator: "\n") : ""
        return try XCTUnwrap(match, "Expected \(labels). Accessibility hierarchy:\n\(hierarchy)")
    }

    private func element(
        _ labels: [String], in applications: [XCUIApplication], timeout: TimeInterval, hittable: Bool
    ) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            for application in applications {
                for label in labels {
                    let matches = application.descendants(matching: .any).matching(identifier: label)
                    for match in matches.allElementsBoundByIndex {
                        if match.exists && (!hittable || match.isHittable) {
                            return match
                        }
                    }
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        return nil
    }
}

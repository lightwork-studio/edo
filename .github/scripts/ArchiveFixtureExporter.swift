import UIKit

@main
final class FixtureApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = FixtureExporter()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

final class FixtureExporter: UIViewController, UIDocumentPickerDelegate {
    private let result = UILabel()
    private var fixtureCount = 0

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let export = UIButton(type: .system)
        export.setTitle("Export fixtures", for: .normal)
        export.addTarget(self, action: #selector(exportFixtures), for: .touchUpInside)
        let controls = UIStackView(arrangedSubviews: [export, result])
        controls.axis = .vertical
        controls.alignment = .center
        controls.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controls)
        NSLayoutConstraint.activate([
            controls.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            controls.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    @objc private func exportFixtures() {
        do {
            let files = FileManager.default
            let fixtureDirectory = Bundle.main.bundleURL.appendingPathComponent("FixtureFiles")
            let fixtures = try files.contentsOfDirectory(
                at: fixtureDirectory, includingPropertiesForKeys: nil
            )
            let staged = files.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try files.createDirectory(at: staged, withIntermediateDirectories: true)
            let copies = try fixtures.map { fixture in
                let copy = staged.appendingPathComponent(fixture.lastPathComponent)
                try files.copyItem(at: fixture, to: copy)
                return copy
            }
            fixtureCount = copies.count
            let picker = UIDocumentPickerViewController(forExporting: copies, asCopy: true)
            picker.modalPresentationStyle = .fullScreen
            picker.delegate = self
            present(picker, animated: true)
        } catch {
            result.text = "Fixture export error: \(error.localizedDescription)"
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        result.text = urls.count == fixtureCount && fixtureCount == 4
            ? "Exported four fixtures"
            : "Unexpected exported file count: \(urls.count)"
    }
}

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
    private var pendingFixture: String?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let names = ["Edo-valid-smoke", "Edo-conflict-smoke", "Edo-malformed-smoke", "Edo-oversized-smoke"]
        let buttons = names.map { name in
            let button = UIButton(type: .system)
            button.setTitle("Export " + name, for: .normal)
            button.addAction(UIAction { [weak self] _ in self?.exportFixture(name) }, for: .touchUpInside)
            return button
        }
        let controls = UIStackView(arrangedSubviews: buttons.map { $0 as UIView } + [result])
        controls.axis = .vertical
        controls.alignment = .center
        controls.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controls)
        NSLayoutConstraint.activate([
            controls.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            controls.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    private func exportFixture(_ name: String) {
        result.text = nil
        do {
            let files = FileManager.default
            let filename = name + ".json"
            let fixture = Bundle.main.bundleURL
                .appendingPathComponent("FixtureFiles")
                .appendingPathComponent(filename)
            let staged = files.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try files.createDirectory(at: staged, withIntermediateDirectories: true)
            let copy = staged.appendingPathComponent(filename)
            try files.copyItem(at: fixture, to: copy)
            pendingFixture = name
            let picker = UIDocumentPickerViewController(forExporting: [copy], asCopy: true)
            picker.modalPresentationStyle = .fullScreen
            picker.delegate = self
            present(picker, animated: true)
        } catch {
            result.text = "Fixture export error: " + error.localizedDescription
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let filenames = urls.map { $0.lastPathComponent }
        if let name = pendingFixture, filenames == [name + ".json"] {
            result.text = "Exported " + name
        } else {
            result.text = "Unexpected exported files: " + filenames.joined(separator: ", ")
        }
        pendingFixture = nil
    }
}

import ExpoModulesCore
import Foundation
import UIKit
import UniformTypeIdentifiers

public final class EdoArchivePickerModule: Module {
  private var pickerDelegate: ArchivePickerDelegate?
  private let readQueue = DispatchQueue(label: "studio.lightwork.edo.archive", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("EdoArchivePicker")

    AsyncFunction("pickArchiveAsync") { (promise: Promise) in
      guard self.pickerDelegate == nil,
            let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject("ERR_EDO_ARCHIVE_PICKER", "Could not open the archive picker")
        return
      }
      let picker = UIDocumentPickerViewController(
        forOpeningContentTypes: [.json, .plainText, .data],
        asCopy: false
      )
      let delegate = ArchivePickerDelegate { [weak self] url in
        guard let self else {
          promise.reject("ERR_EDO_ARCHIVE_PICKER", "The archive picker closed")
          return
        }
        guard let url else {
          self.pickerDelegate = nil
          promise.resolve(["status": "cancelled"])
          return
        }
        self.readQueue.async { [weak self] in
          let selection = try? readSelection(url)
          DispatchQueue.main.async { [weak self] in
            self?.pickerDelegate = nil
            if let selection {
              promise.resolve(selection)
            } else {
              promise.reject("ERR_EDO_ARCHIVE_READ", "Could not read the selected diary archive")
            }
          }
        }
      }
      self.pickerDelegate = delegate
      picker.delegate = delegate
      picker.presentationController?.delegate = delegate
      picker.modalPresentationStyle = .pageSheet
      presenter.present(picker, animated: true)
    }.runOnQueue(.main)
  }
}

private final class ArchivePickerDelegate: NSObject,
  UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
  private var onFinish: ((URL?) -> Void)?

  init(onFinish: @escaping (URL?) -> Void) {
    self.onFinish = onFinish
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    finish(urls.first)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finish(nil)
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish(nil)
  }

  private func finish(_ url: URL?) {
    let callback = onFinish
    onFinish = nil
    callback?(url)
  }
}

private func readSelection(_ url: URL) throws -> [String: String] {
  guard url.startAccessingSecurityScopedResource() else {
    throw ArchiveReadError.unreadable
  }
  defer { url.stopAccessingSecurityScopedResource() }

  if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
     size > maxArchiveBytes {
    return ["status": "too-large"]
  }

  var coordinationError: NSError?
  var result: Result<String?, Error>?
  NSFileCoordinator().coordinate(readingItemAt: url, options: .withoutChanges, error: &coordinationError) {
    coordinatedURL in
    result = Result {
      let handle = try FileHandle(forReadingFrom: coordinatedURL)
      defer { try? handle.close() }
      return try readArchive(from: handle)
    }
  }
  if let coordinationError { throw coordinationError }
  guard let result else { throw ArchiveReadError.unreadable }
  guard let source = try result.get() else { return ["status": "too-large"] }
  return ["status": "selected", "source": source]
}

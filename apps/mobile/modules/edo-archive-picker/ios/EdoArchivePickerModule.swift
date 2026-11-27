import ExpoModulesCore
import Foundation
import UIKit
import UniformTypeIdentifiers

public final class EdoArchivePickerModule: Module {
  private var pickerDelegate: ArchivePickerDelegate?
  private var activeReads = 0
  private let readQueue = DispatchQueue(
    label: "studio.lightwork.edo.archive",
    qos: .userInitiated,
    attributes: .concurrent
  )

  public func definition() -> ModuleDefinition {
    Name("EdoArchivePicker")

    AsyncFunction("pickArchiveAsync") { (promise: Promise) in
      guard self.activeReads < 2 else {
        promise.reject("ERR_EDO_ARCHIVE_PROVIDER_BUSY", "The file provider is still busy")
        return
      }
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
        self.readFromProvider(url, promise: promise)
      }
      self.pickerDelegate = delegate
      picker.delegate = delegate
      picker.presentationController?.delegate = delegate
      picker.modalPresentationStyle = .pageSheet
      presenter.present(picker, animated: true)
    }.runOnQueue(.main)
  }

  private func readFromProvider(_ url: URL, promise: Promise) {
    activeReads += 1
    let cancellation = ArchiveReadCancellation()
    let coordinator = NSFileCoordinator()
    let deadline = DispatchWorkItem { [weak self] in
      cancellation.cancel()
      coordinator.cancel()
      self?.pickerDelegate = nil
      promise.reject("ERR_EDO_ARCHIVE_TIMEOUT", "Timed out reading the selected diary archive")
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: deadline)
    readQueue.async { [weak self] in
      let selection = try? readSelection(url, coordinator: coordinator, cancellation: cancellation)
      DispatchQueue.main.async { [weak self] in
        self?.activeReads -= 1
        guard !cancellation.isCancelled else { return }
        deadline.cancel()
        self?.pickerDelegate = nil
        if let selection {
          promise.resolve(selection)
        } else {
          promise.reject("ERR_EDO_ARCHIVE_READ", "Could not read the selected diary archive")
        }
      }
    }
  }
}

private final class ArchiveReadCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false

  var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }

  func cancel() {
    lock.lock()
    defer { lock.unlock() }
    cancelled = true
  }

  func check() throws {
    if isCancelled { throw ArchiveReadError.unreadable }
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

private func readSelection(
  _ url: URL,
  coordinator: NSFileCoordinator,
  cancellation: ArchiveReadCancellation
) throws -> [String: String] {
  try cancellation.check()
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
  try cancellation.check()
  coordinator.coordinate(readingItemAt: url, options: .withoutChanges, error: &coordinationError) {
    coordinatedURL in
    result = Result {
      try cancellation.check()
      let handle = try FileHandle(forReadingFrom: coordinatedURL)
      defer { try? handle.close() }
      return try readArchive(from: handle, checkCancellation: cancellation.check)
    }
  }
  if let coordinationError { throw coordinationError }
  guard let result else { throw ArchiveReadError.unreadable }
  guard let source = try result.get() else { return ["status": "too-large"] }
  return ["status": "selected", "source": source]
}

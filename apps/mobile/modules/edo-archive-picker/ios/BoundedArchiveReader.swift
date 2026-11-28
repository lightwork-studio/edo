import Foundation

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

let maxArchiveBytes = 16 * 1024 * 1024

enum ArchiveReadError: Error {
  case unreadable
}

// Read one byte beyond the budget only to distinguish EOF from an oversized file.
func readArchive(
  from handle: FileHandle,
  maxBytes: Int = maxArchiveBytes,
  requireArchiveObject: Bool = true,
  checkCancellation: () throws -> Void = {}
) throws -> String? {
  let descriptor = handle.fileDescriptor
  let flags = fcntl(descriptor, F_GETFL)
  guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) >= 0 else {
    throw ArchiveReadError.unreadable
  }
  defer { _ = fcntl(descriptor, F_SETFL, flags) }

  var ready = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
  var buffer = [UInt8](repeating: 0, count: 64 * 1024)
  var data = Data()
  while true {
    try checkCancellation()
    // A provider stream can stay open without producing bytes or EOF.
    let available = poll(&ready, 1, 200)
    if available == 0 || (available < 0 && errno == EINTR) { continue }
    guard available > 0 else { throw ArchiveReadError.unreadable }

    let remaining = maxBytes - data.count
    let count = buffer.withUnsafeMutableBytes {
      read(descriptor, $0.baseAddress, min($0.count, remaining + 1))
    }
    if count < 0 && (errno == EAGAIN || errno == EINTR) { continue }
    guard count >= 0 else { throw ArchiveReadError.unreadable }
    if count == 0 { break }
    guard count <= remaining else { return nil }
    data.append(contentsOf: buffer.prefix(count))
  }
  try checkCancellation()
  guard let source = String(data: data, encoding: .utf8) else {
    throw ArchiveReadError.unreadable
  }
  // Reject literal NUL before any native string conversion.
  guard !source.utf8.contains(0) else { throw ArchiveReadError.unreadable }
  if requireArchiveObject {
    let scalars = source.unicodeScalars
    let start = scalars.first?.value == 0xFEFF ? scalars.index(after: scalars.startIndex) : scalars.startIndex
    let prefix = scalars[start...].first { scalar in
      switch scalar.value {
      case 9, 10, 13, 32: return false
      default: return true
      }
    }
    guard prefix?.value == 0x7B else { throw ArchiveReadError.unreadable }
  }
  return source
}

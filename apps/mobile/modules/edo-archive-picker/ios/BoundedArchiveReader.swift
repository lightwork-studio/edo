import Foundation

let maxArchiveBytes = 16 * 1024 * 1024

enum ArchiveReadError: Error {
  case unreadable
}

// Read one byte beyond the budget only to distinguish EOF from an oversized file.
func readArchive(
  from handle: FileHandle,
  maxBytes: Int = maxArchiveBytes,
  checkCancellation: () throws -> Void = {}
) throws -> String? {
  var data = Data()
  while true {
    try checkCancellation()
    let remaining = maxBytes - data.count
    guard let chunk = try handle.read(upToCount: min(64 * 1024, remaining + 1)),
          !chunk.isEmpty else {
      break
    }
    guard chunk.count <= remaining else {
      return nil
    }
    data.append(chunk)
  }
  try checkCancellation()
  guard let source = String(data: data, encoding: .utf8) else {
    throw ArchiveReadError.unreadable
  }
  let scalars = source.unicodeScalars
  let start = scalars.first?.value == 0xFEFF ? scalars.index(after: scalars.startIndex) : scalars.startIndex
  let prefix = scalars[start...].first { scalar in
    switch scalar.value {
    case 9, 10, 13, 32: return false
    default: return true
    }
  }
  // Reject literal NUL before any native string conversion.
  guard prefix?.value == 0x7B, !source.utf8.contains(0) else {
    throw ArchiveReadError.unreadable
  }
  return source
}

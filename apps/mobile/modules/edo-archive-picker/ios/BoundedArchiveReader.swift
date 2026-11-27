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
  let body = scalars.first == "\u{FEFF}" ? scalars.dropFirst() : scalars[...]
  guard body.first(where: { $0 != " " && $0 != "\t" && $0 != "\r" && $0 != "\n" }) == "{" else {
    throw ArchiveReadError.unreadable
  }
  return source
}

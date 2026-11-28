import Dispatch
import Foundation

enum ProbeError: Error { case deadline }

let pipe = Pipe()
let done = DispatchSemaphore(value: 0)
DispatchQueue.global().async {
    let deadline = DispatchTime.now() + .milliseconds(350)
    do {
        _ = try readArchive(from: pipe.fileHandleForReading, maxBytes: 16) {
            if DispatchTime.now() >= deadline { throw ProbeError.deadline }
        }
        fatalError("A stalled stream returned before cancellation")
    } catch ProbeError.deadline {
        done.signal()
    } catch {
        fatalError("Unexpected error from a stalled stream: \(error)")
    }
}
// The pipe's write end stays open. Closing it would hide the stalled read.
precondition(done.wait(timeout: .now() + .seconds(2)) == .success,
             "A stalled archive read ignored cancellation")
try pipe.fileHandleForWriting.close()
try pipe.fileHandleForReading.close()
print("A stalled archive stream released its reader after cancellation")

func readFixture(_ source: String, maxBytes: Int, requireArchiveObject: Bool) throws -> String? {
    let fixture = Pipe()
    defer { try? fixture.fileHandleForReading.close() }
    try fixture.fileHandleForWriting.write(contentsOf: Data(source.utf8))
    try fixture.fileHandleForWriting.close()
    return try readArchive(
        from: fixture.fileHandleForReading,
        maxBytes: maxBytes,
        requireArchiveObject: requireArchiveObject
    )
}

let body = "Datum;Lebensmittel\r\n27.11.2026;Äpfel"
let csv = "\u{FEFF}" + body
let byteCount = csv.utf8.count
let text = try readFixture(csv, maxBytes: byteCount, requireArchiveObject: false)
// Foundation can remove the UTF-8 BOM. The CSV payload must be preserved.
precondition(text == csv || text == body, "CSV payload should cross the bridge intact")
let oversized = try readFixture(csv, maxBytes: byteCount - 1, requireArchiveObject: false)
precondition(oversized == nil, "CSV should have the same byte limit as archives")
do {
    _ = try readFixture(csv, maxBytes: byteCount, requireArchiveObject: true)
    fatalError("Archive restore accepted a CSV")
} catch ArchiveReadError.unreadable {}
do {
    _ = try readFixture("Datum;\0", maxBytes: 16, requireArchiveObject: false)
    fatalError("CSV import accepted a literal NUL")
} catch ArchiveReadError.unreadable {}

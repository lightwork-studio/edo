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

package studio.lightwork.edo.archive

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets

internal const val MAX_ARCHIVE_BYTES = 16 * 1024 * 1024

// Read one byte beyond the budget only to distinguish EOF from an oversized stream.
internal fun readArchive(input: InputStream, maxBytes: Int = MAX_ARCHIVE_BYTES): String? {
  val output = ByteArrayOutputStream()
  val buffer = ByteArray(64 * 1024)
  while (true) {
    val remaining = maxBytes - output.size()
    val count = input.read(buffer, 0, minOf(buffer.size, remaining + 1))
    if (count == -1) break
    if (count == 0) throw IOException("The selected archive stream made no progress")
    if (count > remaining) return null
    output.write(buffer, 0, count)
  }
  return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(output.toByteArray())).toString()
}

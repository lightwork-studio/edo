package studio.lightwork.edo.archive

import java.io.InputStream
import java.nio.charset.CharacterCodingException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BoundedArchiveReaderTest {
  @Test
  fun decodesAnExactLimitWithoutRequiringASeekableFile() {
    val text = "{\"food\":\"Äpfel 🍎\"}"
    val bytes = text.toByteArray(Charsets.UTF_8)
    val stream = ChunkedInput(bytes)
    assertEquals(text, readArchive(stream, bytes.size))
    assertEquals(bytes.size, stream.consumed)
  }

  @Test
  fun stopsReadingAfterTheFirstExcessByte() {
    val stream = ChunkedInput(ByteArray(1_000))
    assertNull(readArchive(stream, 23))
    assertEquals(24, stream.consumed)
  }

  @Test(expected = CharacterCodingException::class)
  fun rejectsMalformedUtf8() {
    readArchive(byteArrayOf(0xc3.toByte(), 0x28).inputStream(), 8)
  }
}

private class ChunkedInput(private val source: ByteArray) : InputStream() {
  var consumed = 0
    private set

  override fun read(): Int {
    if (consumed >= source.size) return -1
    return source[consumed++].toInt() and 0xff
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (consumed >= source.size) return -1
    val count = minOf(3, length, source.size - consumed)
    source.copyInto(buffer, offset, consumed, consumed + count)
    consumed += count
    return count
  }
}

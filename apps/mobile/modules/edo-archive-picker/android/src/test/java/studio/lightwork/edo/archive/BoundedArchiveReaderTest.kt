package studio.lightwork.edo.archive

import java.io.IOException
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

  @Test
  fun acceptsAnObjectAfterBomAndJsonWhitespace() {
    val source = "\uFEFF\r\n\t {}"
    assertEquals(source, readArchive(source.byteInputStream(), 16))
  }

  @Test(expected = IOException::class)
  fun rejectsNonObjectTextBeforeNativeConversion() {
    readArchive("not json".byteInputStream(), 16)
  }

  @Test
  fun acceptsBomPrefixedCsvOnlyWhenReadingDiaryText() {
    val source = "\uFEFFDatum;Lebensmittel\r\n27.11.2026;Äpfel"
    val bytes = source.toByteArray(Charsets.UTF_8)
    assertEquals(source, readArchive(ChunkedInput(bytes), bytes.size, requireArchiveObject = false))
    assertNull(readArchive(ChunkedInput(bytes), bytes.size - 1, requireArchiveObject = false))
  }

  @Test
  fun rejectsLiteralNulAndPreservesAnEscapedNul() {
    val escaped = "{\"field\":\"\\u0000\"}"
    assertEquals(escaped, readArchive(escaped.byteInputStream(), 24))
    try {
      readArchive("{}\u0000trailing".byteInputStream(), 16)
      throw AssertionError("Accepted a literal NUL")
    } catch (_: IOException) {}
  }

  @Test(expected = IOException::class)
  fun rejectsLiteralNulInDiaryText() {
    readArchive("Datum;\u0000".byteInputStream(), 16, requireArchiveObject = false)
  }

  @Test
  fun checksCancellationBeforeReadingAnotherChunk() {
    val stream = ChunkedInput(ByteArray(20))
    try {
      readArchive(stream, 20) {
        if (stream.consumed > 0) throw IOException("Cancelled")
      }
      throw AssertionError("Read continued after cancellation")
    } catch (error: IOException) {
      assertEquals("Cancelled", error.message)
      assertEquals(3, stream.consumed)
    }
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

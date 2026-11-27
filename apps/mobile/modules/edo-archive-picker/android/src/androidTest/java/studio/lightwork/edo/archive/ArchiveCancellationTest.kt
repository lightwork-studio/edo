package studio.lightwork.edo.archive

import android.content.res.AssetFileDescriptor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import java.io.ByteArrayInputStream
import java.io.FilterInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ArchiveCancellationTest {
  @Test(timeout = 10000)
  fun canceledPipeReleasesItsReaderWhileTheWriterRemainsOpen() {
    val worker = Executors.newSingleThreadExecutor()
    try {
      repeat(2) {
        val (pipeReader, pipeWriter) = ParcelFileDescriptor.createPipe()
        pipeWriter.use {
          val signal = CancellationSignal()
          val descriptor = AssetFileDescriptor(pipeReader, 0, AssetFileDescriptor.UNKNOWN_LENGTH)
          val reading = CountDownLatch(1)
          val input = object : FilterInputStream(descriptor.createInputStream()) {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
              reading.countDown()
              return super.read(buffer, offset, length)
            }
          }
          val pending = worker.submit<Result<String?>> {
            runCatching { readCancellableArchive(input, signal) }
          }
          assertTrue(reading.await(2, TimeUnit.SECONDS))
          assertThrows(TimeoutException::class.java) { pending.get(200, TimeUnit.MILLISECONDS) }
          signal.cancel()
          assertTrue(pending.get(2, TimeUnit.SECONDS).isFailure)
        }
      }
      val healthy = worker.submit<String?> {
        readCancellableArchive(ByteArrayInputStream("{}".toByteArray()), CancellationSignal())
      }
      assertEquals("{}", healthy.get(2, TimeUnit.SECONDS))
    } finally {
      worker.shutdownNow()
    }
  }
}

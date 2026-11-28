package studio.lightwork.edo.archive

import android.content.res.AssetFileDescriptor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import java.io.FileInputStream
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
      for (openReadsFromPipe in listOf(false, true)) {
        val (pipeReader, pipeWriter) = ParcelFileDescriptor.createPipe()
        pipeWriter.use {
          val signal = CancellationSignal()
          val reading = CountDownLatch(1)
          val descriptor = object : AssetFileDescriptor(
            pipeReader, 0, AssetFileDescriptor.UNKNOWN_LENGTH,
          ) {
            override fun createInputStream(): FileInputStream {
              val stream = super.createInputStream()
              reading.countDown()
              if (openReadsFromPipe) stream.read()
              return stream
            }
          }
          val pending = worker.submit<Result<String?>> {
            runCatching { readCancellableArchive(descriptor, signal) }
          }
          assertTrue(reading.await(2, TimeUnit.SECONDS))
          assertThrows(TimeoutException::class.java) { pending.get(200, TimeUnit.MILLISECONDS) }
          signal.cancel()
          assertTrue(pending.get(2, TimeUnit.SECONDS).isFailure)
        }
      }
      val (pipeReader, pipeWriter) = ParcelFileDescriptor.createPipe()
      ParcelFileDescriptor.AutoCloseOutputStream(pipeWriter).use { it.write("{}".toByteArray()) }
      val healthy = worker.submit<String?> {
        val descriptor = AssetFileDescriptor(pipeReader, 0, AssetFileDescriptor.UNKNOWN_LENGTH)
        readCancellableArchive(descriptor, CancellationSignal())
      }
      assertEquals("{}", healthy.get(2, TimeUnit.SECONDS))
    } finally {
      worker.shutdownNow()
    }
  }
}

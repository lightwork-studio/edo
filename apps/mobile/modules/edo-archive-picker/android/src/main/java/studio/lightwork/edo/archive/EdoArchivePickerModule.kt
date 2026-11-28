package studio.lightwork.edo.archive

import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.res.AssetFileDescriptor
import android.net.Uri
import android.os.CancellationSignal
import android.provider.OpenableColumns
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

private const val READ_TIMEOUT_MS = 45_000L

class EdoArchivePickerModule : Module() {
  // A broken provider may ignore cancellation. Allow one retry without building an unbounded queue.
  private val readWorkers = ThreadPoolExecutor(0, 2, 30, TimeUnit.SECONDS, SynchronousQueue())
  private var pendingPicker: ArchivePickerRequest? = null

  override fun definition() = ModuleDefinition {
    Name("EdoArchivePicker")

    lateinit var launcher: AppContextActivityResultLauncher<String, Uri?>
    RegisterActivityContracts {
      launcher = registerForActivityResult(ArchivePickerContract()) { requestId, _ ->
        pendingPicker?.takeIf { it.id == requestId }?.result?.completeExceptionally(pickerInterrupted())
      }
    }
    OnActivityDestroys { pendingPicker?.result?.completeExceptionally(pickerInterrupted()) }
    OnDestroy { readWorkers.shutdownNow() }

    AsyncFunction("pickArchiveAsync") Coroutine { ->
      pickFile(launcher, requireArchiveObject = true)
    }
    AsyncFunction("pickFddbCsvAsync") Coroutine { ->
      pickFile(launcher, requireArchiveObject = false)
    }
  }

  private suspend fun pickFile(
    launcher: AppContextActivityResultLauncher<String, Uri?>,
    requireArchiveObject: Boolean,
  ): Map<String, String> =
    try {
      val uri = chooseFile(launcher)
      if (uri == null) {
        mapOf("status" to "cancelled")
      } else {
        val resolver = requireNotNull(appContext.reactContext).contentResolver
        readFromProvider(resolver, uri, requireArchiveObject)
      }
    } catch (_: TimeoutCancellationException) {
      throw CodedException("ERR_EDO_ARCHIVE_TIMEOUT", "Timed out reading the selected diary file", null)
    } catch (_: RejectedExecutionException) {
      throw CodedException("ERR_EDO_ARCHIVE_PROVIDER_BUSY", "The file provider is still busy", null)
    } catch (error: CodedException) {
      throw error
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      throw CodedException("ERR_EDO_ARCHIVE_READ", "Could not read the selected diary file", null)
    }

  private suspend fun chooseFile(launcher: AppContextActivityResultLauncher<String, Uri?>): Uri? =
    withContext(Dispatchers.Main.immediate) {
      if (pendingPicker != null) throw pickerInterrupted()
      val request = ArchivePickerRequest(UUID.randomUUID().toString(), CompletableDeferred())
      pendingPicker = request
      try {
        launcher.launch(request.id) { uri -> request.result.complete(uri) }
        request.result.await()
      } finally {
        pendingPicker = null
      }
    }

  private suspend fun readFromProvider(
    resolver: ContentResolver,
    uri: Uri,
    requireArchiveObject: Boolean,
  ): Map<String, String> =
    withTimeout(READ_TIMEOUT_MS) {
      suspendCancellableCoroutine { continuation ->
        val signal = CancellationSignal()
        continuation.invokeOnCancellation { signal.cancel() }
        readWorkers.execute {
          val result = try {
            Result.success(readSelection(resolver, uri, signal, requireArchiveObject))
          } catch (error: Exception) {
            Result.failure(error)
          }
          continuation.resumeWith(result)
        }
      }
    }
}

private data class ArchivePickerRequest(val id: String, val result: CompletableDeferred<Uri?>)

private fun pickerInterrupted() =
  CodedException("ERR_EDO_ARCHIVE_PICKER", "The archive picker was interrupted. Choose the file again.", null)

private class ArchivePickerContract : AppContextActivityResultContract<String, Uri?> {
  override fun createIntent(context: Context, input: String) =
    Intent(Intent.ACTION_GET_CONTENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(
        Intent.EXTRA_MIME_TYPES,
        arrayOf(
          "application/json",
          "text/csv",
          "text/comma-separated-values",
          "text/plain",
          "application/octet-stream",
        ),
      )
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

  override fun parseResult(input: String, resultCode: Int, intent: Intent?): Uri? =
    if (resultCode == Activity.RESULT_OK) intent?.data else null
}

private fun readSelection(
  resolver: ContentResolver,
  uri: Uri,
  signal: CancellationSignal,
  requireArchiveObject: Boolean,
): Map<String, String> {
  require(uri.scheme == ContentResolver.SCHEME_CONTENT)
  // Some providers omit or misreport size. The stream limit is always enforced.
  val declaredSize = runCatching {
    resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null, signal)?.use { cursor ->
      if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null
    }
  }.getOrNull()
  if (declaredSize != null && declaredSize > MAX_ARCHIVE_BYTES) {
    return mapOf("status" to "too-large")
  }
  signal.throwIfCanceled()
  val descriptor = requireNotNull(resolver.openAssetFileDescriptor(uri, "r", signal))
  val source = readCancellableArchive(descriptor, signal, requireArchiveObject)
  return if (source == null) mapOf("status" to "too-large")
  else mapOf("status" to "selected", "source" to source)
}

internal fun readCancellableArchive(
  descriptor: AssetFileDescriptor,
  signal: CancellationSignal,
  requireArchiveObject: Boolean = true,
): String? {
  val closed = AtomicBoolean()
  fun closeDescriptor() {
    if (closed.compareAndSet(false, true)) descriptor.close()
  }
  // After openAssetFileDescriptor returns, the provider no longer handles its cancellation
  // signal. Take ownership before stream construction, which can also touch the descriptor.
  signal.setOnCancelListener { runCatching { closeDescriptor() } }
  try {
    signal.throwIfCanceled()
    return readArchive(
      descriptor.createInputStream(),
      requireArchiveObject = requireArchiveObject,
      checkCancellation = signal::throwIfCanceled,
    )
  } finally {
    signal.setOnCancelListener(null)
    closeDescriptor()
  }
}

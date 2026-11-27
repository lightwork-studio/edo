package studio.lightwork.edo.archive

import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class EdoArchivePickerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("EdoArchivePicker")

    lateinit var launcher: AppContextActivityResultLauncher<String, Uri?>
    RegisterActivityContracts {
      launcher = registerForActivityResult(ArchivePickerContract())
    }

    AsyncFunction("pickArchiveAsync") Coroutine { ->
      try {
        val uri = launcher.launch("application/json")
        if (uri == null) {
          mapOf("status" to "cancelled")
        } else {
          val resolver = requireNotNull(appContext.reactContext).contentResolver
          withContext(Dispatchers.IO) { readSelection(resolver, uri) }
        }
      } catch (error: CancellationException) {
        throw error
      } catch (_: Exception) {
        throw CodedException("ERR_EDO_ARCHIVE_READ", "Could not read the selected diary archive", null)
      }
    }
  }
}

private class ArchivePickerContract : AppContextActivityResultContract<String, Uri?> {
  override fun createIntent(context: Context, input: String) =
    Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(input, "text/plain", "application/octet-stream"))
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

  override fun parseResult(input: String, resultCode: Int, intent: Intent?): Uri? =
    if (resultCode == Activity.RESULT_OK) intent?.data else null
}

private fun readSelection(resolver: ContentResolver, uri: Uri): Map<String, String> {
  require(uri.scheme == ContentResolver.SCHEME_CONTENT)
  // Some providers omit or misreport size. The stream limit is always enforced.
  val declaredSize = runCatching {
    resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null
    }
  }.getOrNull()
  if (declaredSize != null && declaredSize > MAX_ARCHIVE_BYTES) {
    return mapOf("status" to "too-large")
  }
  val source = requireNotNull(resolver.openInputStream(uri)).use { readArchive(it) }
  return if (source == null) mapOf("status" to "too-large")
  else mapOf("status" to "selected", "source" to source)
}

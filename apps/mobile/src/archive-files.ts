import { randomUUID } from "expo-crypto";
import { getDocumentAsync } from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";

const exportFolder = "edo-diary-exports";
const exportLifetimeMs = 24 * 60 * 60 * 1000;
const maxArchiveBytes = 16 * 1024 * 1024;

export class ArchiveSizeError extends RangeError {}

function checkArchiveSize(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Could not measure the archive");
  if (bytes > maxArchiveBytes)
    throw new ArchiveSizeError("Diary archive exceeds the mobile file limit");
}

export function pruneArchiveExports(now = Date.now()): void {
  try {
    const root = new Directory(Paths.cache, exportFolder);
    if (!root.exists) return;
    for (const entry of root.list()) {
      if (!(entry instanceof Directory)) continue;
      const match = /^(\d+)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.exec(
        entry.name,
      );
      if (match && now - Number(match[1]) >= exportLifetimeMs) entry.delete();
    }
  } catch {
    // The OS can also discard this cache independently.
  }
}

export async function shareArchive(source: string, now = Date.now()): Promise<void> {
  if (!(await isAvailableAsync())) throw new Error("Archive sharing is unavailable");
  checkArchiveSize(source.length);
  pruneArchiveExports(now);
  const directory = new Directory(Paths.cache, exportFolder, `${now}-${randomUUID()}`);
  directory.create({ intermediates: true });
  try {
    const file = new File(directory, "edo-diary.json");
    file.create();
    await file.write(source);
    checkArchiveSize(file.size);
    await shareAsync(file.uri, { mimeType: "application/json", UTI: "public.json" });
    // The receiving app can open the file after the share sheet returns.
  } catch (error) {
    try {
      if (directory.exists) directory.delete();
    } catch {
      // A failed cleanup can be retried when Diary files reopens.
    }
    throw error;
  }
}

export async function chooseArchive(): Promise<string | null> {
  const result = await getDocumentAsync({
    type: ["application/json", "text/plain", "application/octet-stream"],
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  const file = new File(asset.uri);
  const pickerCache = new Directory(Paths.cache, "DocumentPicker");
  try {
    checkArchiveSize(file.size);
    return await file.text();
  } finally {
    // Remove only Expo's imported cache copy. The selected file outside that directory remains owned by its provider.
    try {
      if (file.parentDirectory.uri === pickerCache.uri && file.exists) file.delete();
    } catch {
      // A cleanup failure should not discard a successfully read archive.
    }
  }
}

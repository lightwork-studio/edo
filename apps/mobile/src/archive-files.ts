import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";

const exportFolder = "edo-diary-exports";
const exportLifetimeMs = 24 * 60 * 60 * 1000;
let activeExport: Directory | null = null;

export function pruneArchiveExports(now = Date.now()): void {
  try {
    const root = new Directory(Paths.cache, exportFolder);
    if (!root.exists) return;
    for (const entry of root.list()) {
      if (!(entry instanceof Directory) || entry.uri === activeExport?.uri) continue;
      const match = /^(\d+)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.exec(
        entry.name,
      );
      if (match && now - Number(match[1]) >= exportLifetimeMs) {
        try {
          entry.delete();
        } catch {
          // Retry this directory on the next cleanup and keep pruning the others.
        }
      }
    }
  } catch {
    // The OS can also discard this cache independently.
  }
}

export async function shareArchive(source: string, now = Date.now()): Promise<void> {
  if (activeExport) throw new Error("Archive sharing is already in progress");
  const directory = new Directory(Paths.cache, exportFolder, `${now}-${randomUUID()}`);
  activeExport = directory;
  let created = false;
  try {
    if (!(await isAvailableAsync())) throw new Error("Archive sharing is unavailable");
    pruneArchiveExports(now);
    directory.create({ intermediates: true });
    created = true;
    const file = new File(directory, "edo-diary.json");
    file.create();
    await file.write(source);
    const bytes = file.size;
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes < source.length) {
      throw new Error("Could not verify the staged archive");
    }
    await shareAsync(file.uri, { mimeType: "application/json", UTI: "public.json" });
    // The receiving app can open the file after the share sheet returns.
  } catch (error) {
    try {
      if (created && directory.exists) directory.delete();
    } catch {
      // App startup, foregrounding, and the next export can retry cleanup.
    }
    throw error;
  } finally {
    activeExport = null;
  }
}

import { requireOptionalNativeModule } from "expo";

type ArchiveSelection =
  | { status: "cancelled" }
  | { status: "too-large" }
  | { status: "selected"; source: string };

const picker = requireOptionalNativeModule<{ pickArchiveAsync(): Promise<ArchiveSelection> }>(
  "EdoArchivePicker",
);
export const archivePickerAvailable = picker !== null;
const maxArchiveJsonStructureTokens = 512_000;
const maxArchiveJsonDepth = 32;
let choosingArchive = false;

export class ArchiveSizeError extends RangeError {}
export class ArchiveComplexityError extends RangeError {}
export class ArchiveReadTimeoutError extends Error {}
export class ArchiveProviderBusyError extends Error {}

function checkArchiveComplexity(source: string): void {
  let inString = false;
  let depth = 0;
  let structureTokens = 0;
  // Bound parser allocations before JSON.parse materializes object-heavy or deeply nested input.
  // JSON.parse still validates syntax and the archive store still validates record content.
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth++;
      structureTokens++;
    } else if (char === "}" || char === "]") {
      depth--;
    } else if (char === ",") {
      structureTokens++;
    }
    if (structureTokens > maxArchiveJsonStructureTokens || depth > maxArchiveJsonDepth) {
      throw new ArchiveComplexityError("Diary archive exceeds mobile JSON limits");
    }
  }
}

export async function chooseDiaryFile(): Promise<string | null> {
  if (!picker || choosingArchive) throw new Error("Archive selection is unavailable");
  choosingArchive = true;
  try {
    const result = await picker.pickArchiveAsync();
    if (result.status === "cancelled") return null;
    if (result.status === "too-large")
      throw new ArchiveSizeError("Diary archive exceeds the restore size limit");
    return result.source.startsWith("\uFEFF") ? result.source.slice(1) : result.source;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "ERR_EDO_ARCHIVE_TIMEOUT") {
        throw new ArchiveReadTimeoutError("Timed out reading the selected diary archive");
      }
      if (error.code === "ERR_EDO_ARCHIVE_PROVIDER_BUSY") {
        throw new ArchiveProviderBusyError("The file provider is still busy");
      }
    }
    throw error;
  } finally {
    choosingArchive = false;
  }
}

export async function chooseArchive(): Promise<string | null> {
  const source = await chooseDiaryFile();
  if (source !== null) checkArchiveComplexity(source);
  return source;
}

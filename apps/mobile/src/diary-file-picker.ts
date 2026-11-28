import { requireOptionalNativeModule } from "expo";

type FileSelection =
  | { status: "cancelled" }
  | { status: "too-large" }
  | { status: "selected"; source: string };

const picker = requireOptionalNativeModule<{
  pickFddbCsvAsync?(): Promise<FileSelection>;
}>("EdoArchivePicker");
export const fddbPickerAvailable = typeof picker?.pickFddbCsvAsync === "function";
let choosingFile = false;

export class DiaryFileSizeError extends RangeError {}
export class DiaryFileReadTimeoutError extends Error {}
export class DiaryFileProviderBusyError extends Error {}

export async function chooseFddbCsv(): Promise<string | null> {
  if (!picker?.pickFddbCsvAsync || choosingFile)
    throw new Error("Diary file selection is unavailable");
  choosingFile = true;
  try {
    const result = await picker.pickFddbCsvAsync();
    if (result.status === "cancelled") return null;
    if (result.status === "too-large")
      throw new DiaryFileSizeError("CSV exceeds the diary file limit");
    return result.source.startsWith("\uFEFF") ? result.source.slice(1) : result.source;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "ERR_EDO_ARCHIVE_TIMEOUT") {
        throw new DiaryFileReadTimeoutError("Timed out reading the selected diary file");
      }
      if (error.code === "ERR_EDO_ARCHIVE_PROVIDER_BUSY") {
        throw new DiaryFileProviderBusyError("The file provider is still busy");
      }
    }
    throw error;
  } finally {
    choosingFile = false;
  }
}

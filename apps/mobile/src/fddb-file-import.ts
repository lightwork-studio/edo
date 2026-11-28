import { planFddbDiaryImport } from "@edo/core";
import type { PrivateArchiveStore } from "@edo/storage";

const maxFddbRecords = 10_000;
const maxPreparedArchiveLength = 16 * 1024 * 1024;

export class InvalidFddbSourceTimeZone extends RangeError {}
export class FddbPreparedSizeError extends RangeError {}

export async function previewFddbFile(
  source: string,
  enteredTimeZone: string,
  diary: Pick<PrivateArchiveStore, "previewPrivateArchive">,
  sha256: (text: string) => Promise<string>,
) {
  const timeZone = enteredTimeZone.trim();
  try {
    if (!timeZone) throw new RangeError("Missing source time zone");
    new Intl.DateTimeFormat("en", { timeZone });
  } catch (error) {
    if (error instanceof RangeError) throw new InvalidFddbSourceTimeZone(error.message);
    throw error;
  }
  const { meals, issues, activityRows } = await planFddbDiaryImport(source, {
    timeZone,
    sha256,
    maxRecords: maxFddbRecords,
  });
  // Bound the escaped archive before joining the records or handing it to SQLite's preview.
  const prefix = '{"format":"edo-diary","formatVersion":1,"meals":[';
  const suffix = "]}";
  const entries: string[] = [];
  let length = prefix.length + suffix.length;
  for (const meal of meals) {
    const encoded = JSON.stringify(meal);
    length += encoded.length + (entries.length === 0 ? 0 : 1);
    if (length > maxPreparedArchiveLength) {
      throw new FddbPreparedSizeError("The prepared FDDB archive exceeds the preview limit");
    }
    entries.push(encoded);
  }
  const archive = prefix + entries.join(",") + suffix;
  const incompleteAtLine = issues.find(({ code }) => code === "malformed-csv")?.line ?? null;
  return {
    archive: incompleteAtLine === null ? archive : null,
    incompleteAtLine,
    issues,
    activityRows,
    storage: diary.previewPrivateArchive(archive),
  };
}

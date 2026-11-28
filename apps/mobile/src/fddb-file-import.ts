import { planFddbDiaryImport } from "@edo/core";
import type { PrivateArchiveStore } from "@edo/storage";

const maxFddbRecords = 10_000;

export class InvalidFddbSourceTimeZone extends RangeError {}

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
  const archive = JSON.stringify({ format: "edo-diary", formatVersion: 1, meals });
  return {
    archive,
    issues,
    activityRows,
    storage: diary.previewPrivateArchive(archive),
  };
}

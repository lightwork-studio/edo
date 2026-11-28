import { createDiaryItem, type DiaryMeal } from "./diary.ts";
import { type FddbDiaryPreview, previewFddbDiaryCsv } from "./fddb-csv.ts";

type TimeIssue = "ambiguous-time" | "missing-time" | "unsupported-offset";

export interface FddbDiaryImportPlan {
  readonly meals: readonly DiaryMeal[];
  readonly activityRows: number;
  readonly issues: readonly {
    line: number;
    code: FddbDiaryPreview["issues"][number]["code"] | TimeIssue;
  }[];
}

const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;

function offsetAt(formatter: Intl.DateTimeFormat, instant: number): number {
  const parts = new Map(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
  const year = Number(parts.get("year"));
  const projected = new Date(0);
  projected.setUTCFullYear(
    parts.get("era") === "BC" ? 1 - year : year,
    Number(parts.get("month")) - 1,
    Number(parts.get("day")),
  );
  projected.setUTCHours(
    Number(parts.get("hour")) % 24,
    Number(parts.get("minute")),
    Number(parts.get("second")),
  );
  return projected.getTime() - instant;
}

function resolveWallTime(
  formatter: Intl.DateTimeFormat,
  localDay: string,
  localTime: string,
): TimeIssue | { occurredAt: number; utcOffsetMinutes: number } {
  const wall = Date.parse(`${localDay}T${localTime}:00.000Z`);
  // Try the offsets on both sides of the wall time to detect a skipped or repeated hour.
  const offsets = new Set([offsetAt(formatter, wall - dayMs), offsetAt(formatter, wall + dayMs)]);
  const candidates = [...offsets].filter((offset) => offsetAt(formatter, wall - offset) === offset);
  const [offset] = candidates;
  if (offset === undefined) return "missing-time";
  if (candidates.length > 1) return "ambiguous-time";
  const utcOffsetMinutes = offset / minuteMs;
  if (!Number.isInteger(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) >= 24 * 60) {
    return "unsupported-offset";
  }
  return { occurredAt: wall - offset, utcOffsetMinutes };
}

/** Prepare diary snapshots for FDDB food rows without saving any records. */
export async function planFddbDiaryImport(
  source: string,
  {
    timeZone,
    sha256,
    maxRecords,
  }: { timeZone: string; sha256: (text: string) => Promise<string>; maxRecords?: number },
): Promise<FddbDiaryImportPlan> {
  if (typeof timeZone !== "string" || !timeZone.trim()) {
    throw new RangeError("Choose the source time zone for the FDDB export");
  }
  const preview = previewFddbDiaryCsv(source, maxRecords);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const issues: FddbDiaryImportPlan["issues"][number][] = [...preview.issues];
  const occurrences = new Map<string, number>();
  let recentRow: { fingerprint: string; hash: string } | undefined;
  let recentFood: { id: string; sourceId: string } | undefined;
  const meals: DiaryMeal[] = [];

  async function digest(text: string): Promise<string> {
    const hash = await sha256(text);
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Invalid FDDB import digest");
    return hash;
  }

  for (const row of preview.rows) {
    const when = resolveWallTime(formatter, row.localDay, row.localTime);
    if (typeof when === "string") {
      issues.push({ line: row.line, code: when });
      continue;
    }
    const fingerprint = JSON.stringify([
      "fddb-diary-row-v1",
      row.localDay,
      row.localTime,
      row.name,
      row.sourceFoodId,
      row.nutrients,
    ]);
    // Repeated identical rows are separate diary entries. The count is independent of the CSV
    // line number, so importing overlapping date ranges does not change existing identities.
    // Count fixed-size digests so long, distinct rows do not remain in the map.
    if (recentRow?.fingerprint !== fingerprint) {
      recentRow = { fingerprint, hash: await digest(fingerprint) };
    }
    const { hash } = recentRow;
    const ordinal = (occurrences.get(hash) ?? 0) + 1;
    occurrences.set(hash, ordinal);
    const id = `fddb-meal-${hash}-${ordinal}`;
    let sourceId = `fddb-entry-${hash}`;
    if (row.sourceFoodId !== null) {
      if (recentFood?.id !== row.sourceFoodId) {
        recentFood = {
          id: row.sourceFoodId,
          sourceId: `fddb-food-${await digest(JSON.stringify(["fddb-food-v1", row.sourceFoodId]))}`,
        };
      }
      sourceId = recentFood.sourceId;
    }
    const item = createDiaryItem(
      `${id}-item`,
      {
        id: { provider: "local", sourceId },
        release: null,
        name: row.name,
        preparation: "unknown",
        nutrition: { basis: "per-portion", nutrients: row.nutrients },
      },
      { amount: 1, unit: "portion" },
    );
    meals.push({ id, localDay: row.localDay, ...when, items: [item] });
  }

  issues.sort((left, right) => left.line - right.line);
  return { meals, issues, activityRows: preview.activityRows };
}

import type { Nutrients } from "./nutrition.ts";

// The German diary CSV produced by the FDDB account website.
const germanHeader = [
  "datum_tag_monat_jahr_stunde_minute",
  "bezeichnung",
  "interne_id",
  "kj",
  "kj_aktivitaeten",
  "fett_g",
  "kh_g",
  "protein_g",
];
const maxBoundedFieldLength = 8_192;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Only tab and line breaks are supported text controls.
const nonTextControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;

export interface FddbDiaryRow {
  readonly line: number;
  readonly localDay: string;
  /** FDDB records a wall time without the time zone or UTC offset. */
  readonly localTime: string;
  readonly name: string;
  readonly sourceFoodId: string | null;
  /** Totals for the FDDB row. The export does not include its weight or portion unit. */
  readonly nutrients: Nutrients;
}

type FddbIssueCode =
  | "unsupported-header"
  | "malformed-csv"
  | "wrong-column-count"
  | "field-too-long"
  | "non-text-control"
  | "invalid-timestamp"
  | "missing-food-name"
  | "invalid-nutrition"
  | "mixed-food-and-activity";

export interface FddbDiaryPreview {
  readonly rows: readonly FddbDiaryRow[];
  readonly activityRows: number;
  readonly issues: readonly { line: number; code: FddbIssueCode }[];
}

export class FddbCsvRecordLimitError extends RangeError {}

function quotedFieldEnd(source: string, start: number): number {
  let end = source.indexOf('"', start + 1);
  while (end !== -1 && source[end + 1] === '"') {
    end = source.indexOf('"', end + 2);
  }
  return end;
}

function bareFieldEnd(source: string, start: number): number {
  let end = start;
  while (end < source.length) {
    const char = source[end];
    if (char === '"' || char === ";" || char === "\r" || char === "\n") break;
    end++;
  }
  return end;
}

function countLineBreaks(source: string, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index++) {
    if (source[index] === "\r") {
      count++;
      if (source[index + 1] === "\n") index++;
    } else if (source[index] === "\n") {
      count++;
    }
  }
  return count;
}

function* records(
  source: string,
  maxFieldLength?: number,
): Generator<{ line: number; fields: string[] | null; oversizedField: boolean }> {
  let cursor = 0;
  let line = 1;
  let rowLine = 1;
  let fields: string[] = [];
  let oversizedField = false;
  while (cursor <= source.length) {
    const quoted = source[cursor] === '"';
    const end = quoted ? quotedFieldEnd(source, cursor) : bareFieldEnd(source, cursor);
    const next = quoted ? end + 1 : end;
    const boundary = source[next];
    if (
      end === -1 ||
      (boundary !== undefined && boundary !== ";" && boundary !== "\r" && boundary !== "\n")
    ) {
      // A broken quoted field can change the location of subsequent record boundaries.
      yield { line: rowLine, fields: null, oversizedField };
      return;
    }
    if (fields.length < germanHeader.length) {
      const start = quoted ? cursor + 1 : cursor;
      if (maxFieldLength !== undefined && end - start > maxFieldLength) {
        oversizedField = true;
        fields.push("");
      } else {
        const value = source.slice(start, end);
        fields.push(quoted ? value.replaceAll('""', '"') : value);
      }
    } else if (fields.length === germanHeader.length) {
      // One extra slot flags an over-wide row. Scan its remainder without retaining any values.
      fields.push("");
    }
    if (quoted) line += countLineBreaks(source, cursor + 1, end);
    cursor = next;
    if (source[cursor] === ";") {
      cursor++;
      continue;
    }
    yield { line: rowLine, fields, oversizedField };
    if (cursor === source.length) return;
    cursor += source.startsWith("\r\n", cursor) ? 2 : 1;
    if (cursor === source.length) return;
    rowLine = ++line;
    fields = [];
    oversizedField = false;
  }
}

function parseNumber(field: string | undefined): number | null {
  const value = field?.trim();
  if (!value) return null;
  return /^\d+(?:,\d+)?$/.test(value) ? Number(value.replace(",", ".")) : Number.NaN;
}

function timestamp(field: string | undefined): { localDay: string; localTime: string } | null {
  const match = field?.trim().match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  const localDay = `${year}-${month}-${day}`;
  const localTime = `${hour}:${minute}`;
  const iso = `${localDay}T${localTime}:00.000Z`;
  const candidate = new Date(iso);
  if (!Number.isFinite(candidate.getTime()) || candidate.toISOString() !== iso) return null;
  return { localDay, localTime };
}

/** Read FDDB rows without writing. A record limit also bounds field length before decoding. */
export function previewFddbDiaryCsv(source: string, maxRecords?: number): FddbDiaryPreview {
  if (maxRecords !== undefined && (!Number.isSafeInteger(maxRecords) || maxRecords < 1)) {
    throw new RangeError("Invalid FDDB record limit");
  }
  const csv = records(
    source.replace(/^\uFEFF/, ""),
    maxRecords === undefined ? undefined : maxBoundedFieldLength,
  );
  const header = csv.next().value?.fields;
  if (
    !header ||
    header.length !== germanHeader.length ||
    !germanHeader.every((field, index) => header[index] === field)
  ) {
    return { rows: [], activityRows: 0, issues: [{ line: 1, code: "unsupported-header" }] };
  }

  const rows: FddbDiaryRow[] = [];
  const issues: { line: number; code: FddbIssueCode }[] = [];
  let activityRows = 0;
  let recordCount = 0;
  for (const { line, fields, oversizedField } of csv) {
    if (maxRecords !== undefined && ++recordCount > maxRecords) {
      throw new FddbCsvRecordLimitError("The FDDB export has too many records");
    }
    if (!fields) {
      issues.push({ line, code: "malformed-csv" });
      break;
    }
    if (oversizedField) {
      issues.push({ line, code: "field-too-long" });
      continue;
    }
    if (fields.length === 1 && !fields[0]?.trim()) continue;
    if (fields.length !== germanHeader.length) {
      issues.push({ line, code: "wrong-column-count" });
      continue;
    }
    if (maxRecords !== undefined && fields.some((field) => nonTextControl.test(field))) {
      issues.push({ line, code: "non-text-control" });
      continue;
    }

    const [time, description, id, energy, activity, fat, carbs, protein] = fields;
    const when = timestamp(time);
    if (!when) {
      issues.push({ line, code: "invalid-timestamp" });
      continue;
    }
    const kj = parseNumber(energy);
    const activityKj = parseNumber(activity);
    const fatG = parseNumber(fat);
    const availableCarbohydratesG = parseNumber(carbs);
    const proteinG = parseNumber(protein);
    const nutrition = [kj, fatG, availableCarbohydratesG, proteinG];
    if ([...nutrition, activityKj].some((value) => value !== null && !Number.isFinite(value))) {
      issues.push({ line, code: "invalid-nutrition" });
      continue;
    }
    if (activityKj !== null && activityKj > 0) {
      if (nutrition.some((value) => value !== null && value > 0)) {
        issues.push({ line, code: "mixed-food-and-activity" });
      } else {
        activityRows++;
      }
      continue;
    }
    const name = description?.trim();
    if (!name) {
      issues.push({ line, code: "missing-food-name" });
      continue;
    }
    rows.push({
      line,
      ...when,
      name,
      sourceFoodId: id?.trim() || null,
      nutrients: {
        kcal: kj === null ? null : kj / 4.184,
        proteinG,
        availableCarbohydratesG,
        fatG,
        fiberG: null,
      },
    });
  }
  return { rows, activityRows, issues };
}

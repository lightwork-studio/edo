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

function readQuotedField(source: string, start: number) {
  let end = source.indexOf('"', start + 1);
  while (end !== -1 && source[end + 1] === '"') {
    end = source.indexOf('"', end + 2);
  }
  return end === -1
    ? null
    : {
        value: source.slice(start + 1, end).replaceAll('""', '"'),
        end: end + 1,
      };
}

function* records(source: string): Generator<{ line: number; fields: string[] | null }> {
  const bareField = /[^";\r\n]*/y;
  let cursor = 0;
  let line = 1;
  let rowLine = 1;
  let fields: string[] = [];
  while (cursor <= source.length) {
    const quoted = source[cursor] === '"';
    bareField.lastIndex = cursor;
    const bare = quoted ? undefined : bareField.exec(source)?.[0];
    const field =
      bare === undefined
        ? readQuotedField(source, cursor)
        : { value: bare, end: cursor + bare.length };
    const boundary = field ? source[field.end] : undefined;
    if (
      !field ||
      (boundary !== undefined && boundary !== ";" && boundary !== "\r" && boundary !== "\n")
    ) {
      // A broken quoted field can change the location of subsequent record boundaries.
      yield { line: rowLine, fields: null };
      return;
    }
    fields.push(field.value);
    if (quoted) line += field.value.match(/\r\n|[\r\n]/g)?.length ?? 0;
    cursor = field.end;
    if (source[cursor] === ";") {
      cursor++;
      continue;
    }
    yield { line: rowLine, fields };
    if (cursor === source.length) return;
    cursor += source.startsWith("\r\n", cursor) ? 2 : 1;
    rowLine = ++line;
    fields = [];
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

/** Read the supported FDDB web export without rewriting dates or inserting records. */
export function previewFddbDiaryCsv(source: string, maxRecords?: number): FddbDiaryPreview {
  if (maxRecords !== undefined && (!Number.isSafeInteger(maxRecords) || maxRecords < 1)) {
    throw new RangeError("Invalid FDDB record limit");
  }
  const csv = records(source.replace(/^\uFEFF/, ""));
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
  for (const { line, fields } of csv) {
    if (fields?.length === 1 && !fields[0]?.trim()) continue;
    if (maxRecords !== undefined && ++recordCount > maxRecords) {
      throw new FddbCsvRecordLimitError("The FDDB export has too many records");
    }
    if (!fields) {
      issues.push({ line, code: "malformed-csv" });
      break;
    }
    if (fields.length !== germanHeader.length) {
      issues.push({ line, code: "wrong-column-count" });
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

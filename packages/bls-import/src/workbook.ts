import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Food } from "@edo/core";
import { unzipSync } from "fflate";
import { XLSX } from "xlsx-extract";

/** The 2025 Max Rubner Institute German distribution's data workbook. */
export const blsWorkbookEntry = "BLS_4_0_2025_DE/BLS_4_0_Daten_2025_DE.xlsx";
const blsSheet = "BLS_4_0_Daten_2025_DE";

export const blsAttribution = {
  name: "Max Rubner-Institut (2025), Bundeslebensmittelschlüssel (BLS), Version 4.0",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  sourceUrl: "https://doi.org/10.25826/Data20251217-134202-0",
  changes:
    "Selected the German and English names and five nutrients per 100 g edible portion. Mapped missing and unquantified values to null and extracted explicit preparation qualifiers.",
};

export interface BlsFood extends Food {
  readonly englishName: string;
}

function requiredColumn(
  headers: readonly unknown[],
  matches: (text: string) => boolean,
  label: string,
) {
  const columns = headers.flatMap((value, index) =>
    typeof value === "string" && matches(value.trim()) ? [index] : [],
  );
  const [column, ...more] = columns;
  if (column === undefined) throw new Error(`Missing BLS column ${label}`);
  if (more.length) throw new Error(`Duplicate BLS column ${label}`);
  return column;
}

function locateColumns(headers: readonly unknown[]) {
  const exact = (label: string) => requiredColumn(headers, (value) => value === label, label);
  const nutrient = (code: string, unit: string) =>
    requiredColumn(
      headers,
      (value) => value.startsWith(`${code} `) && value.endsWith(`[${unit}/100g]`),
      `${code} [${unit}/100g]`,
    );
  return {
    id: exact("BLS Code"),
    name: exact("Lebensmittelbezeichnung"),
    englishName: exact("Food name"),
    kcal: nutrient("ENERCC", "kcal"),
    protein: nutrient("PROT625", "g"),
    carbs: nutrient("CHO", "g"),
    fat: nutrient("FAT", "g"),
    fiber: nutrient("FIBT", "g"),
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be text`);
  }
  return value;
}

const unknownNutrients = new Set(["", "-", "TR", "<LOD", "<LOQ", "<LOD or <LOQ"]);
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

interface WorkbookCell {
  readonly address?: string;
  readonly typ?: string;
  readonly val?: unknown;
}

function cellValue(cell: WorkbookCell | undefined): unknown {
  const value = cell?.val;
  if (cell?.typ === "n" && typeof value === "string") {
    return decimal.test(value) ? Number(value) : Number.NaN;
  }
  return value;
}

function nutrientValue(value: unknown, code: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && unknownNutrients.has(value.trim())) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new Error(`${code} must be a finite non-negative number or a BLS missing-value marker`);
}

function preparationOf(german: string, english: string): BlsFood["preparation"] {
  // The translation can identify a trailing German qualifier as belonging to an ingredient.
  const rawIngredient = /\bwith\s+[^,()]*\braw\s+\p{L}/iu.test(english);
  const raw =
    (!rawIngredient && /(?:^|[\s,])roh$|\(roh\)/iu.test(german)) ||
    /(?:^|[\s,])raw$|\(raw\)|^(?:certified )?raw milk(?:$|[\s,(])/iu.test(english);
  const cooked =
    /(?:^|[\s,(])(?:gekocht|gegart|gedämpft|druckgedämpft|gedünstet|gegrillt|gebacken|gebraten|geröstet|frittiert|pochiert|gar\s*gezogen|gratiniert|überbacken|gebrüht)(?=$|\s*[,()]|\s+(?:in|im|mit|ohne|auf|am|bei)\b|\s+\p{L}+(?:-\p{L}+)?\s+Art\b)/iu.test(
      german,
    ) ||
    /(?:^|[\s,(])(?:cooked|boiled|steamed|pressure-steamed|braised|grilled|baked|roasted|fried|deep-fried|poached|gratinated|scalded)(?=$|\s*[,()]|\s+(?:in|with|without|on|over|at)\b|\s+\p{L}+(?:-\p{L}+)?\s+style\b)|^(?:cooked|boiled|baked|braised|fried|scalded)\s+\p{L}/iu.test(
      english,
    );
  if (raw === cooked) return "unknown";
  return raw ? "raw" : "cooked";
}

function normalizeRow(
  cells: readonly WorkbookCell[],
  columns: ReturnType<typeof locateColumns>,
  release: string,
): BlsFood {
  const sourceId = requiredText(cellValue(cells[columns.id]), "BLS Code");
  const name = requiredText(cellValue(cells[columns.name]), "German name").trim();
  const englishName = requiredText(cellValue(cells[columns.englishName]), "English name").trim();
  return {
    id: { provider: "bls", sourceId },
    release,
    name,
    englishName,
    preparation: preparationOf(name, englishName),
    nutrition: {
      basis: "per-100-g",
      nutrients: {
        kcal: nutrientValue(cellValue(cells[columns.kcal]), "ENERCC"),
        proteinG: nutrientValue(cellValue(cells[columns.protein]), "PROT625"),
        availableCarbohydratesG: nutrientValue(cellValue(cells[columns.carbs]), "CHO"),
        fatG: nutrientValue(cellValue(cells[columns.fat]), "FAT"),
        fiberG: nutrientValue(cellValue(cells[columns.fiber]), "FIBT"),
      },
    },
  };
}

/** Read one data sheet and retain only normalized rows in memory. */
export async function readBlsWorkbook(path: string, release: string): Promise<BlsFood[]> {
  requiredText(release, "BLS release");
  const foods = new Map<string, BlsFood>();
  let columns: ReturnType<typeof locateColumns> | undefined;
  let number = 0;
  let invalidRow: Error | undefined;

  await new Promise<void>((resolve, reject) => {
    new XLSX()
      .extract(path, {
        sheet_name: blsSheet,
        format: "obj",
        raw_values: true,
      })
      .on("row", ({ cells }: { cells: WorkbookCell[] }) => {
        number += 1;
        if (invalidRow) return;
        try {
          if (!columns) {
            columns = locateColumns(cells.map(cellValue));
          } else if (cells.some(({ val }) => val !== undefined && val !== null && val !== "")) {
            const food = normalizeRow(cells, columns, release);
            if (foods.has(food.id.sourceId))
              throw new Error(`Duplicate BLS Code ${food.id.sourceId}`);
            foods.set(food.id.sourceId, food);
          }
        } catch (cause) {
          const rowNumber =
            cells.find((cell) => cell.address)?.address?.match(/\d+$/)?.[0] ?? number;
          const reason = cause instanceof Error ? cause.message : String(cause);
          invalidRow = new Error(`BLS workbook row ${rowNumber}: ${reason}`, { cause });
        }
      })
      .on("error", reject)
      .once("end", resolve);
  });

  if (invalidRow) throw invalidRow;
  if (!foods.size) throw new Error(`BLS data sheet ${blsSheet} has no food rows`);
  // Sort identifiers by their code units, independent of locale and physical workbook order.
  return [...foods.values()].sort((first, second) => {
    const a = first.id.sourceId;
    const b = second.id.sourceId;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Extract just the data workbook to a private temporary directory, then stream its rows. */
export async function readBlsArchive(
  path: string,
  release: string,
  expectedSha256?: string,
): Promise<BlsFood[]> {
  const bytes = await readFile(path);
  if (expectedSha256 && createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error("BLS release archive does not match the pinned SHA-256");
  }
  const archive = unzipSync(bytes, {
    filter: (entry) => entry.name === blsWorkbookEntry,
  });
  const workbook = archive[blsWorkbookEntry];
  if (!workbook) throw new Error(`BLS release archive is missing ${blsWorkbookEntry}`);

  const scratch = await mkdtemp(join(tmpdir(), "edo-bls-"));
  try {
    const input = join(scratch, "data.xlsx");
    await writeFile(input, workbook, { mode: 0o600 });
    return await readBlsWorkbook(input, release);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

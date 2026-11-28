import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { unzipSync } from "fflate";
import {
  carbohydrateByDifference,
  type Measurement,
  previewNutrition,
  units,
} from "./nutrients.ts";

const source = {
  provider: "usda",
  dataset: "SR Legacy",
  release: "2018-04",
  url: "https://fdc.nal.usda.gov/download-datasets/",
  attribution: "USDA FoodData Central",
  license: "CC0 1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  archiveSha256: "b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0",
  archiveBytes: 6074592,
} as const;
const directory = "FoodData_Central_sr_legacy_food_csv_2018-04/";

interface LegacyTables {
  food: string;
  legacyFood: string;
  nutrient: string;
  derivation: string;
  foodNutrient: string;
}

interface LegacyFood {
  readonly fdcId: number;
  readonly ndbNumber: string;
  readonly description: string;
  readonly publicationDate: string;
  readonly measurements: Map<number, Measurement>;
}

/** Read the quoted comma-separated format used by the pinned archive. */
function* quotedRows(csv: string) {
  let cursor = 0;
  while (cursor < csv.length) {
    const fields: string[] = [];
    for (;;) {
      if (csv[cursor] !== '"') throw new Error("Expected a quoted SR Legacy CSV field");
      let end = csv.indexOf('"', cursor + 1);
      while (end !== -1 && csv[end + 1] === '"') end = csv.indexOf('"', end + 2);
      if (end === -1) throw new Error("Unclosed SR Legacy CSV field");
      fields.push(csv.slice(cursor + 1, end).replaceAll('""', '"'));
      cursor = end + 1;
      const delimiter = csv[cursor];
      if (delimiter === ",") {
        cursor += 1;
        continue;
      }
      if (delimiter !== undefined && delimiter !== "\r" && delimiter !== "\n") {
        throw new Error("Invalid SR Legacy CSV delimiter");
      }
      if (delimiter !== undefined) cursor += csv.startsWith("\r\n", cursor) ? 2 : 1;
      break;
    }
    yield fields;
  }
}

function* rows<Column extends string>(
  input: string,
  columns: readonly Column[],
): Generator<Record<Column, string>> {
  const records = quotedRows(input);
  const header = records.next().value;
  if (
    header?.length !== columns.length ||
    columns.some((column, index) => header[index] !== column)
  )
    throw new Error("Unexpected SR Legacy CSV header");
  for (const fields of records) {
    if (fields.length !== columns.length) throw new Error("Unexpected SR Legacy CSV columns");
    yield Object.fromEntries(columns.map((column, index) => [column, fields[index]])) as Record<
      Column,
      string
    >;
  }
}

function identifier(value: string, label: string) {
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id < 1) {
    throw new Error(`Invalid SR Legacy ${label}`);
  }
  return id;
}

function setUnique<K, V>(map: Map<K, V>, key: K, value: V, label: string) {
  if (map.has(key)) throw new Error(`Duplicate SR Legacy ${label}`);
  map.set(key, value);
}

export function mapLegacyFoods(tables: LegacyTables) {
  const ndbIds = new Map<number, string>();
  for (const { fdc_id, NDB_number } of rows(tables.legacyFood, ["fdc_id", "NDB_number"])) {
    identifier(NDB_number, "NDB number");
    setUnique(ndbIds, identifier(fdc_id, "FDC ID"), NDB_number, "NDB row");
  }
  const foods = new Map<number, LegacyFood>();
  for (const row of rows(tables.food, [
    "fdc_id",
    "data_type",
    "description",
    "food_category_id",
    "publication_date",
  ])) {
    const fdcId = identifier(row.fdc_id, "FDC ID");
    const ndbNumber = ndbIds.get(fdcId);
    if (
      row.data_type !== "sr_legacy_food" ||
      !ndbNumber ||
      !row.description.trim() ||
      !row.publication_date
    ) {
      throw new Error("Invalid SR Legacy food row");
    }
    setUnique(
      foods,
      fdcId,
      {
        fdcId,
        ndbNumber,
        description: row.description,
        publicationDate: row.publication_date,
        measurements: new Map(),
      },
      "food row",
    );
  }
  if (foods.size === 0 || foods.size !== ndbIds.size)
    throw new Error("Unmatched SR Legacy NDB row");

  const listedNutrients = new Set<number>();
  for (const row of rows(tables.nutrient, ["id", "name", "unit_name", "nutrient_nbr", "rank"])) {
    const id = identifier(row.id, "nutrient ID");
    const unit = units.get(id);
    if (!unit) continue;
    if (row.unit_name.toUpperCase() !== unit || listedNutrients.has(id)) {
      throw new Error("Invalid or duplicate SR Legacy nutrient definition");
    }
    listedNutrients.add(id);
  }

  const derivations = new Map<number, string>();
  for (const row of rows(tables.derivation, ["id", "code", "description", "source_id"])) {
    if (!row.code.trim()) throw new Error("Missing SR Legacy derivation code");
    setUnique(derivations, identifier(row.id, "derivation ID"), row.code, "derivation");
  }

  for (const row of rows(tables.foodNutrient, [
    "id",
    "fdc_id",
    "nutrient_id",
    "amount",
    "data_points",
    "derivation_id",
    "min",
    "max",
    "median",
    "footnote",
    "min_year_acquired",
  ])) {
    const nutrientId = identifier(row.nutrient_id, "nutrient ID");
    const unit = units.get(nutrientId);
    if (!unit) continue;
    const food = foods.get(identifier(row.fdc_id, "FDC ID"));
    const derivationCode = row.derivation_id
      ? derivations.get(identifier(row.derivation_id, "derivation ID"))
      : null;
    if (!food || !listedNutrients.has(nutrientId) || derivationCode === undefined) {
      throw new Error("Unmatched SR Legacy nutrient reference");
    }
    const amount = row.amount === "" ? null : Number(row.amount);
    if (
      amount !== null &&
      (!/^-?\d+(?:\.\d+)?$/.test(row.amount) ||
        !Number.isFinite(amount) ||
        (amount < 0 && nutrientId !== carbohydrateByDifference))
    ) {
      throw new Error("Invalid SR Legacy nutrient amount");
    }
    setUnique(
      food.measurements,
      nutrientId,
      {
        nutrientId,
        unit,
        amount,
        quantificationLimit: null,
        derivationCode,
      },
      "nutrient measurement",
    );
  }

  return [...foods.values()]
    .sort((a, b) => a.fdcId - b.fdcId)
    .map(({ measurements, ...food }) => ({ ...food, ...previewNutrition(measurements) }));
}

export function previewLegacyArchive(archive: Uint8Array) {
  if (
    archive.byteLength !== source.archiveBytes ||
    createHash("sha256").update(archive).digest("hex") !== source.archiveSha256
  ) {
    throw new Error("SR Legacy archive does not match the pinned release");
  }
  const required = [
    "food.csv",
    "sr_legacy_food.csv",
    "nutrient.csv",
    "food_nutrient_derivation.csv",
    "food_nutrient.csv",
  ];
  const files = unzipSync(archive, {
    filter: ({ name }) =>
      name.startsWith(directory) && required.includes(name.slice(directory.length)),
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  function table(name: string) {
    const data = files[`${directory}${name}`];
    if (!data) throw new Error("Missing SR Legacy CSV table");
    return decoder.decode(data);
  }
  return {
    source,
    foods: mapLegacyFoods({
      food: table("food.csv"),
      legacyFood: table("sr_legacy_food.csv"),
      nutrient: table("nutrient.csv"),
      derivation: table("food_nutrient_derivation.csv"),
      foodNutrient: table("food_nutrient.csv"),
    }),
  };
}

if (import.meta.main) {
  const [filename, ...extra] = process.argv.slice(2);
  if (!filename || extra.length)
    throw new Error("Usage: preview:legacy <SR Legacy 2018-04 CSV ZIP>");
  await using file = await open(filename, "r");
  const stat = await file.stat();
  if (!stat.isFile() || stat.size !== source.archiveBytes) {
    throw new Error("SR Legacy archive does not match the pinned release");
  }
  console.log(JSON.stringify(previewLegacyArchive(await file.readFile()), null, 2));
}

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { unzipSync } from "fflate";

const source = {
  provider: "usda",
  dataset: "Foundation Foods",
  release: "2026-10",
  url: "https://fdc.nal.usda.gov/download-datasets/",
  attribution: "USDA FoodData Central",
  license: "CC0 1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  archiveSha256: "dd414cc9f1a132626bad354ef6655972c78b44aff14f16114dc899708663c579",
  archiveBytes: 696866,
} as const;
const archiveEntry = "FoodData_Central_foundation_food_json_2026-10-29.json";
const carbohydrateByDifference = 1005;
const energyPreference = [2048, 2047, 1008];
type Unit = "G" | "KCAL";
const units = new Map<number, Unit>([
  [1003, "G"],
  [1004, "G"],
  [carbohydrateByDifference, "G"],
  [1079, "G"],
  ...energyPreference.map((id) => [id, "KCAL"] as const),
]);

interface Measurement {
  readonly nutrientId: number;
  readonly unit: Unit;
  readonly amount: number | null;
  readonly quantificationLimit: number | null;
  readonly derivationCode: string | null;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Foundation Foods object");
  }
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid Foundation Foods array");
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid Foundation Foods ${name}`);
  return value;
}

function identifier(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid Foundation Foods ${name}`);
  }
  return value;
}

function measurement(value: unknown, signed = false): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || (!signed && value < 0)) {
    throw new Error("Invalid Foundation Foods nutrient amount or quantification limit");
  }
  return value;
}

function readFood(input: unknown) {
  const row = object(input);
  if (row.dataType !== "Foundation") throw new Error("Expected a Foundation Foods record");
  const fdcId = identifier(row.fdcId, "FDC ID");
  const measurements = new Map<number, Measurement>();
  for (const input of list(row.foodNutrients)) {
    const nutrient = object(input);
    const metadata = object(nutrient.nutrient);
    const nutrientId = identifier(metadata.id, "nutrient ID");
    const unit = units.get(nutrientId);
    if (!unit) continue;
    if (
      text(metadata.unitName, "nutrient unit").toUpperCase() !== unit ||
      measurements.has(nutrientId)
    ) {
      throw new Error(`Invalid or duplicate nutrient ${nutrientId} in Foundation food ${fdcId}`);
    }
    const derivation = nutrient.foodNutrientDerivation;
    const code = derivation == null ? null : object(derivation).code;
    measurements.set(nutrientId, {
      nutrientId,
      unit,
      amount: measurement(nutrient.amount, nutrientId === carbohydrateByDifference),
      quantificationLimit: measurement(nutrient.loq),
      derivationCode: code == null ? null : text(code, "derivation code"),
    });
  }

  function quantified(nutrientId: number): number | null {
    const observed = measurements.get(nutrientId);
    if (!observed || observed.amount === null || observed.amount < 0) return null;
    const { amount, quantificationLimit } = observed;
    return quantificationLimit !== null && quantificationLimit > 0 && amount <= quantificationLimit
      ? null
      : amount;
  }

  const energyNutrientId = energyPreference.find((id) => quantified(id) !== null) ?? null;
  return {
    fdcId,
    ndbNumber: row.ndbNumber == null ? null : identifier(row.ndbNumber, "NDB number"),
    description: text(row.description, "food description"),
    publicationDate: text(row.publicationDate, "food publication date"),
    nutrition: {
      basis: "per-100-g",
      nutrients: {
        kcal: energyNutrientId === null ? null : quantified(energyNutrientId),
        proteinG: quantified(1003),
        availableCarbohydratesG: null,
        fatG: quantified(1004),
        fiberG: quantified(1079),
      },
    },
    carbohydrateByDifferenceG: quantified(carbohydrateByDifference),
    energyNutrientId,
    sourceMeasurements: [...measurements.values()].sort((a, b) => a.nutrientId - b.nutrientId),
  };
}

export function mapFoundationFoods(input: unknown) {
  const rows = list(object(input).FoundationFoods).map(readFood);
  if (new Set(rows.map(({ fdcId }) => fdcId)).size !== rows.length) {
    throw new Error("Duplicate Foundation Foods FDC ID");
  }
  return rows.sort((a, b) => a.fdcId - b.fdcId);
}

export function previewFoundationArchive(archive: Uint8Array) {
  if (
    archive.byteLength !== source.archiveBytes ||
    createHash("sha256").update(archive).digest("hex") !== source.archiveSha256
  ) {
    throw new Error("Foundation Foods archive does not match the pinned release");
  }
  const data = unzipSync(archive)[archiveEntry];
  if (!data) throw new Error("Missing Foundation Foods JSON file");
  const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  return { source, foods: mapFoundationFoods(decoded) };
}

if (import.meta.main) {
  const [filename, ...extra] = process.argv.slice(2);
  if (!filename || extra.length) throw new Error("Usage: preview <Foundation Foods 2026-10 ZIP>");
  await using file = await open(filename, "r");
  const stat = await file.stat();
  if (!stat.isFile() || stat.size !== source.archiveBytes) {
    throw new Error("Foundation Foods archive does not match the pinned release");
  }
  const archive = await file.readFile();
  console.log(JSON.stringify(previewFoundationArchive(archive), null, 2));
}

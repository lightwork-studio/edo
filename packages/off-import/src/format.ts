import {
  type FoodNutrition,
  type FoodPreparation,
  type MeasuredPortion,
  normalizeOpenFoodFactsBarcode as normalizeLookupCode,
  type PackagedFood,
  sanitizePackagedNutrition,
} from "@edo/core";

export { normalizeLookupCode };

export interface ParsedProduct {
  food: Omit<PackagedFood, "barcode" | "alternateName">;
  barcode: string;
  lookupCode: string;
  nameDe: string | null;
  nameEn: string | null;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readAmount(value: unknown, unit: "g" | "kcal" | "kj"): number | null {
  const field = asObject(value);
  // Our numeric representation cannot preserve bounds, traces, or estimates.
  if (!field || (field.modifier != null && field.modifier !== "")) return null;
  const known = amount(field.value);
  if (known === null) return null;
  const sourceUnit = text(field.unit)?.toLowerCase();
  if (sourceUnit === unit) return known;
  return unit === "g" && sourceUnit === "mg" ? known / 1000 : null;
}

function readEnergy(values: Record<string, unknown>): number | null {
  const kcal = readAmount(values["energy-kcal"], "kcal") ?? readAmount(values.energy, "kcal");
  if (kcal !== null) return kcal;
  const kilojoules = readAmount(values["energy-kj"], "kj") ?? readAmount(values.energy, "kj");
  return kilojoules === null ? null : kilojoules / 4.184;
}

function measuredServing(value: unknown, rawUnit: unknown): MeasuredPortion | undefined {
  const size = amount(value);
  if (!size) return undefined;
  const unit = text(rawUnit)?.toLowerCase();
  if (unit === "g" || unit === "ml") return { amount: size, unit };
  if (unit === "kg" || unit === "l") {
    const baseSize = size * 1000;
    if (Number.isFinite(baseSize)) return { amount: baseSize, unit: unit === "kg" ? "g" : "ml" };
  }
  return undefined;
}

function foodNutrition(
  set: Record<string, unknown> | undefined,
  portionSize: MeasuredPortion | undefined,
): FoodNutrition | null {
  let basis: FoodNutrition["basis"];
  switch (set?.per) {
    case "100g":
      basis = "per-100-g";
      break;
    case "100ml":
      basis = "per-100-ml";
      break;
    case "serving":
      basis = "per-portion";
      break;
    default:
      return null;
  }
  const values = asObject(set.nutrients);
  if (!values) return null;
  const nutrients = {
    kcal: readEnergy(values),
    proteinG: readAmount(values.proteins, "g"),
    availableCarbohydratesG: readAmount(values.carbohydrates, "g"),
    fatG: readAmount(values.fat, "g"),
    fiberG: readAmount(values.fiber, "g"),
  };
  if (Object.values(nutrients).every((value) => value === null)) return null;
  return { basis, nutrients, ...(portionSize && { portionSize }) };
}

function preparationOf(set: Record<string, unknown> | undefined): FoodPreparation {
  if (set?.preparation === "as_sold") return "as-sold";
  if (set?.preparation === "prepared") return "prepared";
  return "unknown";
}

function labeledServing(inputSets: unknown) {
  if (!Array.isArray(inputSets)) return null;
  let serving: { nutrition: FoodNutrition; preparation: FoodPreparation } | null = null;
  for (const entry of inputSets) {
    const set = asObject(entry);
    if (set?.per !== "serving" || (set.source !== "packaging" && set.source !== "manufacturer")) {
      continue;
    }
    const nutrition = foodNutrition(set, measuredServing(set.per_quantity, set.per_unit));
    if (!nutrition) continue;
    // Multiple serving sets may refer to different portions or preparation states.
    if (serving) return null;
    serving = { nutrition, preparation: preparationOf(set) };
  }
  return serving;
}

/** Skip products outside the first market; reject malformed products inside it. */
export function readOpenFoodFactsProduct(
  value: unknown,
  release: string,
  market: "germany" | "all" = "germany",
): ParsedProduct | "outside-scope" | null {
  const product = asObject(value);
  if (!product) return null;
  if (
    product.deleted === true ||
    product.deleted === "on" ||
    (market === "germany" &&
      (!Array.isArray(product.countries_tags) || !product.countries_tags.includes("en:germany")))
  ) {
    return "outside-scope";
  }
  const barcode = text(product.code);
  if (!barcode) return null;
  const lookupCode = normalizeLookupCode(barcode);
  const nameDe = text(product.product_name_de);
  const nameEn = text(product.product_name_en);
  const name = nameDe ?? nameEn ?? text(product.product_name);
  if (!lookupCode || !name) return null;

  const sourceNutrition = asObject(product.nutrition);
  const aggregate = asObject(sourceNutrition?.aggregated_set);
  const aggregateNutrition = foodNutrition(
    aggregate,
    measuredServing(product.serving_quantity, product.serving_quantity_unit),
  );
  const serving = aggregateNutrition ? null : labeledServing(sourceNutrition?.input_sets);
  const nutrition = aggregateNutrition ?? serving?.nutrition ?? null;
  return {
    barcode,
    lookupCode,
    nameDe,
    nameEn,
    food: {
      id: { provider: "open-food-facts", sourceId: text(product._id) ?? barcode },
      release,
      name,
      preparation: serving?.preparation ?? preparationOf(aggregate),
      nutrition: nutrition && sanitizePackagedNutrition(nutrition),
    },
  };
}

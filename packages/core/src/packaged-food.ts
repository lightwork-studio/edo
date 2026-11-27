import type { Food, FoodPreparation } from "./food.ts";
import type { FoodNutrition, MeasuredPortion } from "./nutrition.ts";

export interface PackagedFood extends Omit<Food, "id" | "nutrition" | "release"> {
  readonly id: { readonly provider: "open-food-facts"; readonly sourceId: string };
  readonly release: string;
  readonly barcode: string;
  readonly alternateName: string | null;
  readonly nutrition: FoodNutrition | null;
}

/** Compute the OFF lookup key while retaining the separately stored original barcode. */
export function normalizeOpenFoodFactsBarcode(barcode: string): string | null {
  if (!/^\d+$/.test(barcode)) return null;
  const significant = barcode.replace(/^0+/, "");
  if (significant.length < 4 || significant.length > 40) return null;
  return significant.padStart(significant.length <= 8 ? 8 : 13, "0");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nutrient(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function declaredMass(nutrition: FoodNutrition): number | undefined {
  if (nutrition.basis === "per-100-g") return 100;
  const portion =
    nutrition.basis === "per-100-ml" ? { amount: 100, unit: "ml" } : nutrition.portionSize;
  if (!positive(portion?.amount)) return undefined;
  if (portion.unit === "g") return portion.amount;
  if (positive(nutrition.gramsPerMilliliter)) {
    return portion.amount * nutrition.gramsPerMilliliter;
  }
  return undefined;
}

function withinLimit(value: number | null, limit: number): number | null {
  return value !== null && value > limit ? null : value;
}

/** Omit individual Open Food Facts values that exceed conservative bounds for the declared mass. */
export function sanitizePackagedNutrition(nutrition: FoodNutrition): FoodNutrition {
  const mass = declaredMass(nutrition);
  if (!positive(mass)) return nutrition;
  // Allow margin above the 9 kcal/g conversion factor for fat and for rounded macro labels.
  const macroLimit = mass + Math.max(1, mass * 0.05);
  const { kcal, proteinG, availableCarbohydratesG, fatG, fiberG } = nutrition.nutrients;
  return {
    ...nutrition,
    nutrients: {
      kcal: withinLimit(kcal, mass * 10),
      proteinG: withinLimit(proteinG, macroLimit),
      availableCarbohydratesG: withinLimit(availableCarbohydratesG, macroLimit),
      fatG: withinLimit(fatG, macroLimit),
      fiberG: withinLimit(fiberG, macroLimit),
    },
  };
}

function decodeNutrition(value: unknown): FoodNutrition | null {
  const data = object(value);
  const basis = data?.basis;
  if (basis !== "per-100-g" && basis !== "per-100-ml" && basis !== "per-portion") return null;
  const nutrients = object(data?.nutrients);
  if (!nutrients) return null;
  const { kcal, proteinG, availableCarbohydratesG, fatG, fiberG } = nutrients;
  if (![kcal, proteinG, availableCarbohydratesG, fatG, fiberG].every(nutrient)) return null;
  const density = data?.gramsPerMilliliter;
  if (density !== undefined && !positive(density)) return null;
  let portionSize: MeasuredPortion | undefined;
  if (data?.portionSize !== undefined) {
    const size = object(data.portionSize);
    if (!positive(size?.amount) || (size?.unit !== "g" && size?.unit !== "ml")) return null;
    portionSize = { amount: size.amount, unit: size.unit };
  }
  return {
    basis,
    nutrients: {
      kcal,
      proteinG,
      availableCarbohydratesG,
      fatG,
      fiberG,
    } as FoodNutrition["nutrients"],
    ...(portionSize && { portionSize }),
    ...(density !== undefined && { gramsPerMilliliter: density }),
  };
}

const preparations: ReadonlySet<string> = new Set([
  "as-sold",
  "prepared",
  "raw",
  "cooked",
  "unknown",
]);

/** Validate public product data and retain only the fields used by Edo. */
export function decodePackagedFood(value: unknown): PackagedFood | null {
  const data = object(value);
  const id = object(data?.id);
  if (!data || id?.provider !== "open-food-facts" || !text(id.sourceId)) return null;
  const { release, barcode, name, alternateName, preparation } = data;
  if (
    !text(release) ||
    !text(barcode) ||
    !normalizeOpenFoodFactsBarcode(barcode) ||
    !text(name) ||
    (alternateName !== null && !text(alternateName)) ||
    typeof preparation !== "string" ||
    !preparations.has(preparation)
  ) {
    return null;
  }
  const nutrition = decodeNutrition(data.nutrition);
  if (data.nutrition !== null && nutrition === null) return null;
  return {
    id: { provider: "open-food-facts", sourceId: id.sourceId },
    release,
    barcode,
    name,
    alternateName,
    preparation: preparation as FoodPreparation,
    nutrition: nutrition && sanitizePackagedNutrition(nutrition),
  };
}

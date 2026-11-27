import type { SQLOutputValue } from "node:sqlite";
import {
  type FoodNutrition,
  type MeasuredPortion,
  type PackagedFood,
  sanitizePackagedNutrition,
} from "@edo/core";

export const barcodeRows = `
  SELECT food.source_id, food.name, food.alternate_name, food.preparation,
    food.nutrition_basis, food.kcal, food.protein_g, food.available_carbohydrates_g, food.fat_g,
    food.fiber_g, food.portion_amount, food.portion_unit, barcode.code, barcode.lookup_code
  FROM barcode JOIN food ON food.source_id COLLATE BINARY = barcode.source_id COLLATE BINARY
`;

function requiredText(value: SQLOutputValue | undefined): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Invalid packaged-food text");
  }
  return value;
}

function nutrient(value: SQLOutputValue | undefined): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid packaged-food nutrient");
  }
  return value;
}

function nutritionForRow(row: Record<string, SQLOutputValue>): FoodNutrition | null {
  const basis = row.nutrition_basis;
  if (basis === null) return null;
  if (basis !== "per-100-g" && basis !== "per-100-ml" && basis !== "per-portion") {
    throw new Error("Unknown packaged-food nutrition basis");
  }
  const amount = row.portion_amount;
  const unit = row.portion_unit;
  const portionSize: MeasuredPortion | undefined =
    typeof amount === "number" &&
    Number.isFinite(amount) &&
    amount > 0 &&
    (unit === "g" || unit === "ml")
      ? { amount, unit }
      : undefined;
  return sanitizePackagedNutrition({
    basis,
    nutrients: {
      kcal: nutrient(row.kcal),
      proteinG: nutrient(row.protein_g),
      availableCarbohydratesG: nutrient(row.available_carbohydrates_g),
      fatG: nutrient(row.fat_g),
      fiberG: nutrient(row.fiber_g),
    },
    ...(portionSize && { portionSize }),
  });
}

export function readProduct(row: Record<string, SQLOutputValue>, release: string): PackagedFood {
  const { preparation, alternate_name: alternateName } = row;
  if (preparation !== "as-sold" && preparation !== "prepared" && preparation !== "unknown") {
    throw new Error("Invalid packaged-food preparation");
  }
  return {
    id: { provider: "open-food-facts", sourceId: requiredText(row.source_id) },
    release,
    barcode: requiredText(row.code),
    name: requiredText(row.name),
    alternateName: alternateName === null ? null : requiredText(alternateName),
    preparation,
    nutrition: nutritionForRow(row),
  };
}

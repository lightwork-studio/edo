import type { FoodNutrition, MeasuredPortion, Nutrients } from "@edo/core";

const nutrientKeys = ["kcal", "proteinG", "availableCarbohydratesG", "fatG", "fiberG"] as const;

export interface CustomFoodFields {
  name: string;
  basis: FoodNutrition["basis"];
  nutrients: Record<keyof Nutrients, string>;
  portionAmount: string;
  portionUnit: MeasuredPortion["unit"];
}

export interface CustomFoodDraft {
  name: string;
  nutrition: FoodNutrition;
}

type InvalidFood = "invalidName" | "invalidNutrient" | "invalidPortion" | "invalidPortionUnit";

type FoodPreview = { macroKcal: number | null } & (
  | { draft: CustomFoodDraft; error: null }
  | { draft: null; error: InvalidFood }
);

function readDecimal(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(trimmed)) return undefined;
  const value = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(value) || (value === 0 && /[1-9]/.test(trimmed))) return undefined;
  return value;
}

function readNutrients(fields: CustomFoodFields["nutrients"]): Nutrients | null {
  const nutrients: { -readonly [Key in keyof Nutrients]: Nutrients[Key] } = {
    kcal: null,
    proteinG: null,
    availableCarbohydratesG: null,
    fatG: null,
    fiberG: null,
  };
  for (const key of nutrientKeys) {
    const value = readDecimal(fields[key]);
    if (value === undefined) return null;
    nutrients[key] = value;
  }
  return nutrients;
}

function estimateEnergy(nutrients: Nutrients | null): number | null {
  if (!nutrients) return null;
  const { proteinG, availableCarbohydratesG, fatG, fiberG } = nutrients;
  if (proteinG === null || availableCarbohydratesG === null || fatG === null) return null;
  const kcal = 4 * proteinG + 4 * availableCarbohydratesG + 9 * fatG + 2 * (fiberG ?? 0);
  return Number.isFinite(kcal) ? kcal : null;
}

export function previewCustomFood(
  fields: CustomFoodFields,
  gramsPerMilliliter?: number,
): FoodPreview {
  const { basis, portionUnit } = fields;
  const name = fields.name.trim();
  const nutrients = readNutrients(fields.nutrients);
  const macroKcal = estimateEnergy(nutrients);
  if (!name) return { draft: null, error: "invalidName", macroKcal };
  if (!nutrients) return { draft: null, error: "invalidNutrient", macroKcal };

  const amount = readDecimal(fields.portionAmount);
  if (amount === undefined || amount === 0) {
    return { draft: null, error: "invalidPortion", macroKcal };
  }
  if (
    amount !== null &&
    gramsPerMilliliter === undefined &&
    ((basis === "per-100-g" && portionUnit !== "g") ||
      (basis === "per-100-ml" && portionUnit !== "ml"))
  ) {
    return { draft: null, error: "invalidPortionUnit", macroKcal };
  }

  return {
    draft: {
      name,
      nutrition: {
        basis,
        nutrients,
        ...(amount !== null && { portionSize: { amount, unit: portionUnit } }),
        ...(gramsPerMilliliter !== undefined && { gramsPerMilliliter }),
      },
    },
    error: null,
    macroKcal,
  };
}

import type { Food, FoodPreparation, FoodProvider } from "./food.ts";
import {
  type FoodNutrition,
  type Nutrients,
  nutritionForPortion,
  type Portion,
} from "./nutrition.ts";

export interface DiaryItem {
  readonly id: string;
  readonly portion: Portion;
  /** Detached from the current catalog so it can also support later portion edits. */
  readonly food: Food;
  /** Calculated at log time and used when reading the diary. */
  readonly nutrients: Nutrients;
}

const providers: readonly FoodProvider[] = ["bls", "open-food-facts", "usda", "local"];
const preparationStates: readonly FoodPreparation[] = [
  "raw",
  "cooked",
  "as-sold",
  "prepared",
  "unknown",
];

function requireText(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} is required`);
  }
}

function captureNutrition(nutrition: FoodNutrition): FoodNutrition {
  const { basis, portionSize, gramsPerMilliliter } = nutrition;
  const { kcal, proteinG, availableCarbohydratesG, fatG, fiberG } = nutrition.nutrients;
  return Object.freeze({
    basis,
    nutrients: Object.freeze({ kcal, proteinG, availableCarbohydratesG, fatG, fiberG }),
    ...(portionSize !== undefined && {
      portionSize: Object.freeze({ amount: portionSize.amount, unit: portionSize.unit }),
    }),
    ...(gramsPerMilliliter !== undefined && { gramsPerMilliliter }),
  });
}

/** Capture catalog data at log time. IDs and release metadata are copied as supplied. */
export function createDiaryItem(id: string, food: Food, portion: Portion): DiaryItem {
  const { provider, sourceId } = food.id;
  const { release, name, preparation, nutrition } = food;
  requireText(id, "Diary item ID");
  requireText(sourceId, "Food source ID");
  requireText(name, "Food name");
  if (!providers.includes(provider)) throw new TypeError("Unknown food provider");
  if (!preparationStates.includes(preparation)) throw new TypeError("Unknown preparation state");
  if (release !== null) requireText(release, "Catalog release");

  const capturedPortion = Object.freeze({ amount: portion.amount, unit: portion.unit });
  const capturedFood = Object.freeze({
    id: Object.freeze({ provider, sourceId }),
    release,
    name,
    preparation,
    nutrition: captureNutrition(nutrition),
  });
  const nutrients = Object.freeze(nutritionForPortion(capturedFood.nutrition, capturedPortion));
  return Object.freeze({
    id,
    portion: capturedPortion,
    food: capturedFood,
    nutrients,
  });
}

/** Use the captured food data when editing a historical portion. */
export function updateDiaryPortion(item: DiaryItem, portion: Portion): DiaryItem {
  return createDiaryItem(item.id, item.food, portion);
}

import {
  createDiaryItem,
  type DiaryItem,
  type Food,
  foodForRecipe,
  nutritionForPortion,
  type Portion,
  type Recipe,
  sumNutrition,
  updateDiaryPortion,
} from "@edo/core";
import { defaultFoodPortion, readAmount } from "./diary-view";

export type IngredientDraft = {
  original: DiaryItem;
  amount?: string;
  unit: Portion["unit"];
};

export function newRecipeIngredient(id: string, food: Food): IngredientDraft {
  const portion = defaultFoodPortion(food);
  return { original: createDiaryItem(id, food, portion), unit: portion.unit };
}

export function ingredientUnits({ original }: IngredientDraft): Portion["unit"][] {
  const units: Portion["unit"][] = ["g", "ml", "portion"];
  return units.filter((unit) => {
    if (unit === original.portion.unit) return true;
    try {
      nutritionForPortion(original.food.nutrition, { amount: 1, unit });
      return true;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return false;
    }
  });
}

export function ingredientUnitChange(
  draft: IngredientDraft,
  unit: Portion["unit"],
): Pick<IngredientDraft, "amount" | "unit"> {
  if (unit === draft.unit) return draft;
  return {
    unit,
    amount: unit === draft.original.portion.unit ? undefined : unit === "portion" ? "1" : "100",
  };
}

export function recipeIngredient({ original, amount, unit }: IngredientDraft): DiaryItem | null {
  const quantity = amount === undefined ? original.portion.amount : readAmount(amount);
  if (quantity === null) return null;
  if (quantity === original.portion.amount && unit === original.portion.unit) return original;
  try {
    return updateDiaryPortion(original, { amount: quantity, unit });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return null;
  }
}

export function previewRecipe(
  name: string,
  ingredients: readonly DiaryItem[],
  servings: number | null,
  cookedWeightG: number | undefined | null,
) {
  if (!ingredients.length || servings === null || cookedWeightG === null) return null;
  const draft: Omit<Recipe, "id"> = {
    name: name.trim(),
    ingredients,
    servings,
    ...(cookedWeightG !== undefined && { cookedWeightG }),
  };
  try {
    const { nutrition } = foodForRecipe({ ...draft, id: "preview", name: draft.name || "Preview" });
    return {
      draft,
      portion: nutrition,
      batch: sumNutrition(
        ingredients.map(({ food, portion }) => nutritionForPortion(food.nutrition, portion)),
      ),
    };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return null;
  }
}

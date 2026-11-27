import type { DiaryItem } from "./diary.ts";
import type { Food, FoodId } from "./food.ts";
import { nutritionForPortion, sumNutrition } from "./nutrition.ts";

export interface Recipe {
  readonly id: string;
  readonly name: string;
  /** Each ingredient has its own stable ID and captures its food and measured portion. */
  readonly ingredients: readonly DiaryItem[];
  readonly servings: number;
  readonly cookedWeightG?: number;
}

/** The result can be logged with the same snapshot and portion rules as other foods. */
export function foodForRecipe(recipe: Recipe): Food {
  const { id, name, ingredients, servings, cookedWeightG } = recipe;
  if (id.trim() === "" || name.trim() === "") throw new TypeError("A recipe needs an ID and name");
  if (!Number.isFinite(servings) || servings <= 0) {
    throw new RangeError("Recipe servings must be finite and positive");
  }
  if (ingredients.length === 0) throw new RangeError("A recipe needs at least one ingredient");
  const ingredientIds = ingredients.map(({ id }) => id);
  if (ingredientIds.some((id) => typeof id !== "string" || id.trim() === "")) {
    throw new TypeError("A recipe ingredient needs an ID");
  }
  if (new Set(ingredientIds).size !== ingredients.length) {
    throw new TypeError("Recipe ingredient IDs must be unique");
  }
  const gramsPerServing = cookedWeightG === undefined ? undefined : cookedWeightG / servings;
  if (
    gramsPerServing !== undefined &&
    (!Number.isFinite(gramsPerServing) || gramsPerServing <= 0)
  ) {
    throw new RangeError("A known cooked weight must give a finite, positive weight per serving");
  }

  const batch = sumNutrition(
    ingredients.map(({ food, portion }) => nutritionForPortion(food.nutrition, portion)),
  );
  const nutrients = nutritionForPortion(
    { basis: "per-portion", nutrients: batch },
    { amount: 1 / servings, unit: "portion" },
  );
  const foodId: FoodId = { provider: "local", sourceId: `recipe:${id}` };
  return {
    id: foodId,
    release: null,
    name,
    preparation: "prepared",
    nutrition: {
      basis: "per-portion",
      nutrients,
      ...(gramsPerServing !== undefined && { portionSize: { amount: gramsPerServing, unit: "g" } }),
    },
  };
}

import { describe, expect, it } from "vitest";
import {
  createDiaryItem,
  type Food,
  foodForRecipe,
  type Recipe,
  updateDiaryPortion,
} from "../src/index.ts";

const oats: Food = {
  id: { provider: "local", sourceId: "oats" },
  name: "Rolled oats",
  release: null,
  preparation: "raw",
  nutrition: {
    basis: "per-100-g",
    nutrients: { kcal: 360, proteinG: 10, availableCarbohydratesG: 60, fatG: 8, fiberG: null },
  },
};
const milk: Food = {
  id: { provider: "open-food-facts", sourceId: "00123" },
  name: "Milk",
  release: "synthetic-release",
  preparation: "as-sold",
  nutrition: {
    basis: "per-100-ml",
    nutrients: { kcal: 40, proteinG: 3, availableCarbohydratesG: 5, fatG: 1, fiberG: 0 },
  },
};
const recipe: Recipe = {
  id: "porridge",
  name: "Porridge",
  ingredients: [
    createDiaryItem("oats-ingredient", oats, { amount: 100, unit: "g" }),
    createDiaryItem("milk-ingredient", milk, { amount: 200, unit: "ml" }),
  ],
  servings: 2,
  cookedWeightG: 240,
};

describe("recipe portions", () => {
  it("logs equivalent measured and serving portions, including unknown nutrients", () => {
    const food = foodForRecipe(recipe);
    const serving = createDiaryItem("serving", food, { amount: 1, unit: "portion" });
    const measured = createDiaryItem("weighed", food, { amount: 120, unit: "g" });
    expect(measured.nutrients).toEqual(serving.nutrients);
    expect(serving.nutrients).toEqual({
      kcal: 220,
      proteinG: 8,
      availableCarbohydratesG: 35,
      fatG: 5,
      fiberG: null,
    });
  });

  it("keeps logged nutrition and portion edits independent of recipe changes or source removal", () => {
    const original = foodForRecipe(recipe);
    const logged = createDiaryItem("meal-entry", original, { amount: 120, unit: "g" });
    const changed = foodForRecipe({
      ...recipe,
      name: "Oats",
      ingredients: recipe.ingredients.slice(0, 1),
    });
    expect(changed.id).toEqual(original.id);
    expect(changed.nutrition.nutrients.kcal).toBe(180);
    expect(logged.food.name).toBe("Porridge");
    expect(logged.nutrients.kcal).toBe(220);
    expect(updateDiaryPortion(logged, { amount: 60, unit: "g" }).nutrients.kcal).toBe(110);
  });

  it("calculates each ingredient from its captured food and current portion", () => {
    const oatsIngredient = recipe.ingredients[0];
    if (!oatsIngredient) throw new Error("Expected an oats ingredient");
    const changed = foodForRecipe({
      ...recipe,
      ingredients: [{ ...oatsIngredient, portion: { amount: 50, unit: "g" } }],
    });
    expect(changed.nutrition.nutrients).toMatchObject({ kcal: 90, proteinG: 2.5, fiberG: null });
  });

  it("requires a cooked weight for logging in grams and validates recipe inputs", () => {
    const { cookedWeightG: _, ...unweighed } = recipe;
    const food = foodForRecipe(unweighed);
    expect(() => createDiaryItem("entry", food, { amount: 30, unit: "g" })).toThrow(
      /measured size/,
    );
    expect(() => foodForRecipe({ ...recipe, servings: 0 })).toThrow(/servings/);
    expect(() => foodForRecipe({ ...recipe, cookedWeightG: 0 })).toThrow(/cooked weight/);
    expect(() => foodForRecipe({ ...recipe, ingredients: [] })).toThrow(/at least one/);
    expect(() =>
      foodForRecipe({ ...recipe, ingredients: [...recipe.ingredients, ...recipe.ingredients] }),
    ).toThrow(/unique/);
  });
});

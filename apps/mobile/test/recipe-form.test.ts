import { DatabaseSync } from "node:sqlite";
import { createDiaryItem, type Food, type PackagedFood, roundNutritionForDisplay } from "@edo/core";
import { openDiary, openPackagedFoodCache, type SqliteConnection } from "@edo/storage";
import { expect, it } from "vitest";
import { searchCachedPackagedFoods } from "../src/packaged-food-search.ts";
import {
  ingredientUnitChange,
  ingredientUnits,
  newRecipeIngredient,
  previewRecipe,
  recipeIngredient,
  recipeIngredientNutrition,
} from "../src/recipe-form.ts";

const baseFood = {
  id: { provider: "local", sourceId: "sauce" },
  name: "Tomato sauce",
  release: null,
  preparation: "prepared",
  nutrition: {
    basis: "per-100-ml",
    nutrients: { kcal: 40, proteinG: 2, availableCarbohydratesG: 6, fatG: 1, fiberG: null },
  },
} satisfies Food;

it("edits a captured ingredient by its stable ID after its source is changed or removed", () => {
  const source = structuredClone(baseFood);
  const foods = [source];
  const ingredient = newRecipeIngredient("sauce-item", source);
  source.name = "New sauce";
  source.nutrition.nutrients.kcal = 90;
  foods.pop();

  expect(recipeIngredient(ingredient)).toBe(ingredient.original);
  expect(ingredientUnits(ingredient)).toEqual(["ml"]);
  const edited = recipeIngredient({ ...ingredient, amount: "250,5" });
  expect(edited).toMatchObject({
    id: "sauce-item",
    food: { name: "Tomato sauce", nutrition: { nutrients: { kcal: 40 } } },
    portion: { amount: 250.5, unit: "ml" },
  });
  expect(edited?.nutrients.kcal).toBeCloseTo(100.2);
  expect(recipeIngredient({ ...ingredient, amount: "" })).toBeNull();
  expect(recipeIngredient({ ...ingredient, unit: "g" })).toBeNull();
});

it("previews recipe servings and cooked grams using each ingredient's supported units", () => {
  const sauce = newRecipeIngredient("sauce-item", baseFood);
  const beans = newRecipeIngredient("beans-item", {
    ...baseFood,
    id: { provider: "local", sourceId: "beans" },
    name: "Beans",
    nutrition: {
      basis: "per-portion",
      portionSize: { amount: 50, unit: "g" },
      nutrients: { kcal: 60, proteinG: 5, availableCarbohydratesG: 10, fatG: 1, fiberG: 2 },
    },
  });
  expect(beans.original.portion).toEqual({ amount: 1, unit: "portion" });
  expect(ingredientUnits(beans)).toEqual(["g", "portion"]);
  const measured = recipeIngredient({ ...beans, unit: "g", amount: "150" });
  expect(measured?.nutrients.kcal).toBe(180);
  if (!measured) throw new Error("Expected a grams-based ingredient");

  const ingredients = [sauce.original, measured];
  expect(previewRecipe("  Beans in sauce  ", ingredients, 2, 200)).toMatchObject({
    draft: { name: "Beans in sauce", servings: 2, cookedWeightG: 200, ingredients },
    portion: { portionSize: { amount: 100, unit: "g" }, nutrients: { kcal: 110, fiberG: null } },
    batch: { kcal: 220, fiberG: null },
  });
  expect(
    previewRecipe("Beans in sauce", ingredients, 2, undefined)?.portion.portionSize,
  ).toBeUndefined();
  expect(previewRecipe("Beans in sauce", ingredients, 2, null)).toBeNull();
});

it("uses an intentional amount when switching units and restores the captured amount", () => {
  const food: Food = {
    ...baseFood,
    nutrition: {
      ...baseFood.nutrition,
      basis: "per-100-g",
      portionSize: { amount: 40, unit: "g" },
      gramsPerMilliliter: 0.8,
      nutrients: { ...baseFood.nutrition.nutrients, kcal: 100 },
    },
  };
  const original = createDiaryItem("apple-item", food, { amount: 75.1234, unit: "g" });
  const byGrams = { original, unit: "g", amount: "125" } as const;
  const byPortion = { ...byGrams, ...ingredientUnitChange(byGrams, "portion") };
  const byMillilitres = { ...byPortion, ...ingredientUnitChange(byPortion, "ml") };
  const backToGrams = { ...byMillilitres, ...ingredientUnitChange(byMillilitres, "g") };

  expect(recipeIngredient(byPortion)).toMatchObject({
    id: original.id,
    portion: { amount: 1, unit: "portion" },
    nutrients: { kcal: 40 },
  });
  expect(recipeIngredient(byMillilitres)?.nutrients.kcal).toBe(80);
  expect(recipeIngredient(backToGrams)).toBe(original);
});

it("uses the same captured food and portion for the batch and logged serving preview", () => {
  const captured = createDiaryItem("legacy", baseFood, { amount: 250.5, unit: "ml" });
  const legacy = { ...captured, nutrients: { ...captured.nutrients, kcal: 99 } };
  const preview = previewRecipe("Recipe", [legacy], 2, undefined);
  expect(preview?.draft.ingredients).toEqual([legacy]);
  expect(recipeIngredientNutrition(legacy).kcal).toBe(captured.nutrients.kcal);
  expect(preview?.batch.kcal).toBe(captured.nutrients.kcal);
  expect(preview?.portion.nutrients.kcal).toBe((captured.nutrients.kcal ?? 0) / 2);
});

it("rounds the ingredient, batch and serving alike at an energy midpoint", () => {
  const food: Food = {
    ...baseFood,
    nutrition: {
      ...baseFood.nutrition,
      basis: "per-100-g",
      nutrients: { ...baseFood.nutrition.nutrients, kcal: 25 },
    },
  };
  const ingredient = createDiaryItem("midpoint", food, { amount: 58, unit: "g" });
  const preview = previewRecipe("One portion", [ingredient], 1, undefined);
  if (!preview) throw new Error("Expected a valid recipe");
  expect(
    [recipeIngredientNutrition(ingredient), preview.batch, preview.portion.nutrients].map(
      (value) => roundNutritionForDisplay(value).kcal,
    ),
  ).toEqual([15, 15, 15]);
});

function sqliteConnection(db: DatabaseSync): SqliteConnection {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...parameters) => void db.prepare(sql).run(...parameters),
    get: (sql, ...parameters) => db.prepare(sql).get(...parameters),
    all: (sql, ...parameters) => db.prepare(sql).all(...parameters),
  };
}

it("captures an offline packaged ingredient independently of later cache refresh and eviction", async () => {
  using publicDb = new DatabaseSync(":memory:");
  using privateDb = new DatabaseSync(":memory:");
  const cacheConnection = sqliteConnection(publicDb);
  const cache = openPackagedFoodCache(cacheConnection);
  const diaryOptions = {
    connection: sqliteConnection(privateDb),
    async backupBeforeMigration() {
      throw new Error("The test diary is blank or current");
    },
  };
  const diary = await openDiary(diaryOptions);
  const product: PackagedFood = {
    id: { provider: "open-food-facts", sourceId: "offline-tomato-juice" },
    name: "Tomato juice",
    alternateName: "Tomatensaft",
    barcode: "034000470693",
    release: "catalog-initial",
    preparation: "as-sold",
    nutrition: {
      basis: "per-100-ml",
      nutrients: { kcal: 20, proteinG: 0, availableCarbohydratesG: 3, fatG: 0, fiberG: null },
    },
  };
  cache.save([product], 100, []);
  const results = searchCachedPackagedFoods(cache, "tomatens", 101);
  expect(results).toHaveLength(1);
  const selected = results[0];
  if (!selected) throw new Error("Expected the cached packaged ingredient");
  const draft = newRecipeIngredient("ingredient", selected);
  expect(draft.original.portion).toEqual({ amount: 100, unit: "ml" });
  const changed = recipeIngredient({ ...draft, amount: "250" });
  if (!changed) throw new Error("Expected a valid millilitre portion");
  const recipe = previewRecipe("Tomato drink", [changed], 2, undefined);
  if (!recipe) throw new Error("Expected a valid recipe");
  diary.saveRecipe({ ...recipe.draft, id: "tomato-drink" });
  expect(recipe.portion.nutrients.kcal).toBe(25);

  cache.save([{ ...product, name: "Tomato nectar", release: "catalog-revised" }], 102, []);
  expect(searchCachedPackagedFoods(cache, "nectar", 103)[0]?.release).toBe("catalog-revised");
  const evictedCache = openPackagedFoodCache(cacheConnection, 0);
  evictedCache.prune([]);
  expect(searchCachedPackagedFoods(evictedCache, "tomatens", 104)).toEqual([]);
  const reopened = await openDiary(diaryOptions);
  expect(reopened.listRecipes()[0]?.ingredients).toEqual([changed]);
  expect(changed).toMatchObject({
    food: { id: product.id, name: product.name, release: product.release },
    portion: { amount: 250, unit: "ml" },
    nutrients: { kcal: 50, proteinG: 0, fiberG: null },
  });
});

it("allows other ingredient sources to remain usable if the packaged cache cannot be queried", () => {
  const brokenCache = {
    search() {
      throw new Error("Cache unavailable");
    },
  };
  expect(searchCachedPackagedFoods(brokenCache, "tomato", 100)).toEqual([]);
  expect(searchCachedPackagedFoods(null, "tomato", 100)).toEqual([]);
});

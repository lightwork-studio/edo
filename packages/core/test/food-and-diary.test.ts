import {
  createDiaryItem,
  type Food,
  type FoodNutrition,
  nutritionForPortion,
  roundNutritionForDisplay,
  sumNutrition,
  updateDiaryPortion,
} from "@edo/core";
import { expect, test } from "vitest";

const nutrients = {
  kcal: 200,
  proteinG: 15,
  availableCarbohydratesG: 25,
  fatG: 0,
  fiberG: null,
};
const perMass: FoodNutrition = { basis: "per-100-g", nutrients };
const perVolume: FoodNutrition = { basis: "per-100-ml", nutrients };
const perPortion: FoodNutrition = { basis: "per-portion", nutrients };

test("scales each declared basis and keeps zero distinct from missing", () => {
  expect(nutritionForPortion(perMass, { unit: "g", amount: 50 })).toEqual({
    kcal: 100,
    proteinG: 7.5,
    availableCarbohydratesG: 12.5,
    fatG: 0,
    fiberG: null,
  });
  expect(nutritionForPortion(perVolume, { unit: "ml", amount: 75 }).kcal).toBe(150);
  expect(nutritionForPortion(perPortion, { unit: "portion", amount: 1.5 }).kcal).toBe(300);
});

test("converts measured portions and density in either direction", () => {
  expect(
    nutritionForPortion(
      { ...perMass, portionSize: { unit: "g", amount: 30 } },
      { unit: "portion", amount: 2 },
    ).kcal,
  ).toBe(120);
  expect(
    nutritionForPortion(
      { ...perPortion, portionSize: { unit: "ml", amount: 200 }, gramsPerMilliliter: 0.5 },
      { unit: "g", amount: 50 },
    ).kcal,
  ).toBe(100);
  expect(
    nutritionForPortion(
      { ...perVolume, portionSize: { unit: "g", amount: 30 }, gramsPerMilliliter: 0.5 },
      { unit: "portion", amount: 1 },
    ).kcal,
  ).toBe(120);
  expect(
    nutritionForPortion({ ...perMass, gramsPerMilliliter: 0.5 }, { unit: "ml", amount: 100 }).kcal,
  ).toBe(100);
});

test("rejects conversions when the needed measurements are missing", () => {
  expect(() => nutritionForPortion(perMass, { unit: "ml", amount: 100 })).toThrow(/density/);
  expect(() => nutritionForPortion(perMass, { unit: "portion", amount: 1 })).toThrow(/size/);
  expect(() => nutritionForPortion(perPortion, { unit: "g", amount: 100 })).toThrow(/size/);
  expect(() =>
    nutritionForPortion(
      { ...perVolume, portionSize: { unit: "g", amount: 30 } },
      { unit: "portion", amount: 1 },
    ),
  ).toThrow(/density/);
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects %s as a portion amount, density or measured size",
  (amount) => {
    expect(() => nutritionForPortion(perMass, { unit: "g", amount })).toThrow(
      /finite and positive/,
    );
    expect(() =>
      nutritionForPortion({ ...perMass, gramsPerMilliliter: amount }, { unit: "ml", amount: 100 }),
    ).toThrow(/finite and positive/);
    expect(() =>
      nutritionForPortion(
        { ...perMass, portionSize: { unit: "g", amount } },
        { unit: "portion", amount: 1 },
      ),
    ).toThrow(/finite and positive/);
  },
);

test("rejects invalid nutrients and a calculation that overflows", () => {
  expect(() =>
    nutritionForPortion(
      { ...perMass, nutrients: { ...nutrients, fatG: -1 } },
      { unit: "g", amount: 50 },
    ),
  ).toThrow(/fatG/);
  expect(() =>
    nutritionForPortion(
      { ...perPortion, nutrients: { ...nutrients, kcal: Number.MAX_VALUE } },
      { unit: "portion", amount: 2 },
    ),
  ).toThrow(/kcal/);
});

test("sums unrounded nutrition and rounds only for display", () => {
  const smallPortion = { ...nutrients, kcal: 2.5, proteinG: 0.24 };
  const total = sumNutrition([smallPortion, smallPortion, { ...smallPortion, fiberG: 1 }]);
  expect(total).toEqual({
    kcal: 7.5,
    proteinG: 0.72,
    availableCarbohydratesG: 75,
    fatG: 0,
    fiberG: null,
  });
  expect(roundNutritionForDisplay(total)).toEqual({ ...total, kcal: 8, proteinG: 0.7 });
  expect(roundNutritionForDisplay({ ...smallPortion, proteinG: 1.25 }).proteinG).toBe(1.3);
  expect(sumNutrition([])).toEqual({
    kcal: 0,
    proteinG: 0,
    availableCarbohydratesG: 0,
    fatG: 0,
    fiberG: 0,
  });
});

test("captures a detached diary snapshot and uses it for later portion edits", () => {
  const catalogFood = {
    id: { provider: "open-food-facts", sourceId: "000101" },
    release: "synthetic-v1",
    name: "Sample cereal",
    preparation: "as-sold",
    nutrition: {
      basis: "per-100-g",
      nutrients: { ...nutrients },
      portionSize: { unit: "g", amount: 30 },
    },
  } satisfies Food;
  const portion = { unit: "portion", amount: 2 } as const;
  const first = createDiaryItem("first", catalogFood, portion);
  const oldTotal = sumNutrition([first.nutrients]);
  expect(Reflect.set(first.food.nutrition.nutrients, "kcal", 250)).toBe(false);
  expect(Reflect.set(first.nutrients, "kcal", 250)).toBe(false);
  expect(Reflect.set(first.portion, "amount", 3)).toBe(false);
  catalogFood.name = "Revised sample cereal";
  catalogFood.release = "synthetic-v2";
  catalogFood.nutrition.nutrients.kcal = 250;
  catalogFood.nutrition.portionSize.amount = 40;

  const second = createDiaryItem("second", catalogFood, portion);
  const edited = updateDiaryPortion(first, { unit: "g", amount: 90 });

  expect(first.food.id).toEqual({ provider: "open-food-facts", sourceId: "000101" });
  expect(first.food.id).not.toBe(catalogFood.id);
  expect(first.food.release).toBe("synthetic-v1");
  expect(first.food.preparation).toBe("as-sold");
  expect(first.food.name).toBe("Sample cereal");
  expect(first.food.nutrition.portionSize).toEqual({ unit: "g", amount: 30 });
  expect(sumNutrition([first.nutrients])).toEqual(oldTotal);
  expect(first.nutrients.kcal).toBe(120);
  expect(second.nutrients.kcal).toBe(200);
  expect(second.food.id).toEqual(first.food.id);
  expect(second.food.release).toBe("synthetic-v2");
  expect(edited.id).toBe("first");
  expect(edited.food.release).toBe("synthetic-v1");
  expect(edited.nutrients.kcal).toBe(180);
  expect(first.portion).toEqual(portion);
  expect(
    createDiaryItem(
      "third",
      { ...catalogFood, id: { ...catalogFood.id, provider: "local" }, release: null },
      portion,
    ).food.id,
  ).not.toEqual(first.food.id);
});

test("copies the declared snapshot fields from getter-backed inputs", () => {
  class MeasuredServing {
    get amount() {
      return 50;
    }
    get unit() {
      return "g" as const;
    }
  }

  class SourceId {
    get provider() {
      return "bls" as const;
    }
    get sourceId() {
      return "X01";
    }
  }

  const entry = createDiaryItem(
    "item",
    {
      id: new SourceId(),
      release: "synthetic",
      name: "Sample food",
      preparation: "raw",
      nutrition: { ...perMass, portionSize: new MeasuredServing() },
    },
    new MeasuredServing(),
  );
  expect(entry.food.id).toEqual({ provider: "bls", sourceId: "X01" });
  expect(entry.portion).toEqual({ amount: 50, unit: "g" });
  expect(entry.food.nutrition.portionSize).toEqual({ amount: 50, unit: "g" });
  expect(updateDiaryPortion(entry, { amount: 1, unit: "portion" }).nutrients).toEqual(
    entry.nutrients,
  );
});

test("reports unknown totals independently of summation order", () => {
  const huge = { ...nutrients, kcal: Number.MAX_VALUE };
  const unknown = { ...nutrients, kcal: null };
  expect(sumNutrition([unknown, huge, huge]).kcal).toBeNull();
  expect(sumNutrition([huge, huge, unknown]).kcal).toBeNull();
  expect(() => sumNutrition([huge, huge])).toThrow(/kcal/);
});

test("rounds half steps reached through portion scaling", () => {
  const food = { ...perMass, nutrients: { ...nutrients, kcal: 50, proteinG: 4.5 } };
  const scaled = nutritionForPortion(food, { amount: 29, unit: "g" });
  const protein = nutritionForPortion(food, { amount: 30, unit: "g" });
  expect(roundNutritionForDisplay(scaled).kcal).toBe(15);
  expect(roundNutritionForDisplay(protein).proteinG).toBe(1.4);
  expect(roundNutritionForDisplay({ ...nutrients, proteinG: 1.34999 }).proteinG).toBe(1.3);
  expect(roundNutritionForDisplay({ ...nutrients, kcal: 4503599627370497 }).kcal).toBe(
    4503599627370497,
  );
});

test("requires usable food and diary IDs", () => {
  const localFood: Food = {
    id: { provider: "local", sourceId: "local-food" },
    release: null,
    name: "Sample manual food",
    preparation: "unknown",
    nutrition: perMass,
  };
  const portion = { unit: "g", amount: 100 } as const;
  expect(() => createDiaryItem("", localFood, portion)).toThrow(/Diary item ID/);
  expect(() =>
    createDiaryItem("item", { ...localFood, id: { ...localFood.id, sourceId: " " } }, portion),
  ).toThrow(/Food source ID/);
});

import { expect, test } from "vitest";
import { type CustomFoodFields, previewCustomFood } from "../src/custom-food-form";

const fields: CustomFoodFields = {
  name: "  Hafer-Protein-Riegel  ",
  basis: "per-100-g",
  nutrients: {
    kcal: "388",
    proteinG: "20",
    availableCarbohydratesG: "45",
    fatG: "12",
    fiberG: "8",
  },
  portionAmount: "45,5",
  portionUnit: "g",
};

test("keeps labeled calories separate from the macro estimate and saves the measured portion", () => {
  expect(previewCustomFood(fields)).toEqual({
    draft: {
      name: "Hafer-Protein-Riegel",
      nutrition: {
        basis: "per-100-g",
        nutrients: { kcal: 388, proteinG: 20, availableCarbohydratesG: 45, fatG: 12, fiberG: 8 },
        portionSize: { amount: 45.5, unit: "g" },
      },
    },
    error: null,
    macroKcal: 384,
  });
});

test("accepts both decimal separators, explicit zero and blank unknown nutrients", () => {
  const nutrients = {
    kcal: " ",
    proteinG: "0",
    availableCarbohydratesG: ".5",
    fatG: "0,5",
    fiberG: "",
  };
  expect(
    previewCustomFood({
      ...fields,
      basis: "per-100-ml",
      nutrients,
      portionAmount: "",
      portionUnit: "ml",
    }).draft?.nutrition,
  ).toEqual({
    basis: "per-100-ml",
    nutrients: { kcal: null, proteinG: 0, availableCarbohydratesG: 0.5, fatG: 0.5, fiberG: null },
  });
  expect(
    previewCustomFood({ ...fields, nutrients: { ...nutrients, fatG: "" } }).macroKcal,
  ).toBeNull();
});

test("supports a per-portion basis with or without a measured size", () => {
  const perPortion = { ...fields, basis: "per-portion" } as const;
  expect(previewCustomFood(perPortion).draft?.nutrition.portionSize).toEqual({
    amount: 45.5,
    unit: "g",
  });
  expect(previewCustomFood({ ...perPortion, portionUnit: "ml" }).draft?.nutrition).toMatchObject({
    basis: "per-portion",
    portionSize: { amount: 45.5, unit: "ml" },
  });
  expect(previewCustomFood({ ...perPortion, portionAmount: "" }).draft?.nutrition).toMatchObject({
    basis: "per-portion",
  });
  expect(
    previewCustomFood({ ...perPortion, portionAmount: "" }).draft?.nutrition.portionSize,
  ).toBeUndefined();
});

test("rejects malformed entries and keeps density when editing an existing food", () => {
  expect(previewCustomFood({ ...fields, name: " " }).error).toBe("invalidName");
  for (const kcal of ["-1", "1e2", "1,2.3", "9".repeat(309)]) {
    expect(previewCustomFood({ ...fields, nutrients: { ...fields.nutrients, kcal } }).error).toBe(
      "invalidNutrient",
    );
  }
  expect(previewCustomFood({ ...fields, portionAmount: "0" }).error).toBe("invalidPortion");
  const volume = { ...fields, portionUnit: "ml" } as const;
  expect(previewCustomFood(volume).error).toBe("invalidPortionUnit");
  expect(previewCustomFood(volume, 1.05).draft?.nutrition).toMatchObject({
    portionSize: { amount: 45.5, unit: "ml" },
    gramsPerMilliliter: 1.05,
  });
});

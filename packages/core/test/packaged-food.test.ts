import { expect, it } from "vitest";
import { decodePackagedFood, type FoodNutrition, sanitizePackagedNutrition } from "../src/index.ts";

const missing = {
  kcal: null,
  proteinG: null,
  availableCarbohydratesG: null,
  fatG: null,
  fiberG: null,
};

it("omits individual OFF values beyond the mass limits and retains exact zero", () => {
  const nutrition = {
    basis: "per-100-g",
    portionSize: { amount: 4, unit: "g" },
    nutrients: {
      kcal: 1000,
      proteinG: 105,
      availableCarbohydratesG: 105.01,
      fatG: 0,
      fiberG: 106,
    },
  } as const;
  expect(sanitizePackagedNutrition(nutrition)).toEqual({
    ...nutrition,
    nutrients: { ...missing, kcal: 1000, proteinG: 105, fatG: 0 },
  });
});

it("uses a measured serving's mass and the one gram minimum tolerance", () => {
  const nutrition = {
    basis: "per-portion",
    portionSize: { amount: 4, unit: "g" },
    nutrients: { ...missing, kcal: 400, fatG: 5, fiberG: 5.01 },
  } as const;
  expect(sanitizePackagedNutrition(nutrition)).toEqual({
    ...nutrition,
    nutrients: { ...missing, fatG: 5 },
  });
});

it("applies volume checks only when the food supplies a density", () => {
  const measured: FoodNutrition = {
    basis: "per-portion",
    portionSize: { amount: 4, unit: "ml" },
    nutrients: { ...missing, kcal: 81, proteinG: 9, fatG: 9.01 },
  };
  const byVolume: FoodNutrition = {
    basis: "per-100-ml",
    portionSize: { amount: 4, unit: "g" },
    nutrients: { ...missing, kcal: 501, proteinG: 53, fatG: 5 },
  };
  expect(sanitizePackagedNutrition(measured)).toEqual(measured);
  expect(sanitizePackagedNutrition(byVolume)).toEqual(byVolume);
  expect(sanitizePackagedNutrition({ ...measured, gramsPerMilliliter: 2 })).toEqual({
    ...measured,
    gramsPerMilliliter: 2,
    nutrients: { ...missing, proteinG: 9 },
  });
  expect(sanitizePackagedNutrition({ ...byVolume, gramsPerMilliliter: 0.5 })).toEqual({
    ...byVolume,
    gramsPerMilliliter: 0.5,
    nutrients: { ...missing, fatG: 5 },
  });
});

it("decodes sanitized OFF products and still rejects invalid nutrition payloads", () => {
  const product = {
    id: { provider: "open-food-facts", sourceId: "0034000470693" },
    barcode: "0034000470693",
    release: "cached-v1",
    name: "Sample food",
    alternateName: null,
    preparation: "as-sold",
  };
  const decode = (nutrients: unknown) =>
    decodePackagedFood({ ...product, nutrition: { basis: "per-100-g", nutrients } });

  expect(decode({ ...missing, kcal: 1001, fatG: 0 })?.nutrition).toEqual({
    basis: "per-100-g",
    nutrients: { ...missing, fatG: 0 },
  });
  expect(decode({ ...missing, kcal: 1001 })).toEqual({
    ...product,
    nutrition: { basis: "per-100-g", nutrients: missing },
  });
  expect(decode(missing)).toEqual({
    ...product,
    nutrition: { basis: "per-100-g", nutrients: missing },
  });
  expect(decodePackagedFood({ ...product, nutrition: null })).toEqual({
    ...product,
    nutrition: null,
  });
  expect(decode({ ...missing, kcal: -1 })).toBeNull();
  expect(decode({ ...missing, kcal: "5" })).toBeNull();
  expect(decode({ kcal: 1 })).toBeNull();
});

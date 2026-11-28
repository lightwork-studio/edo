import { expect, test } from "vitest";
import { mapFoundationFoods, previewFoundationArchive } from "../src/foundation.ts";

function nutrient(id: number, unitName: string, amount: number, loq?: number) {
  return {
    nutrient: { id, unitName },
    amount,
    loq,
    foodNutrientDerivation: { code: "A" },
  };
}

function food(fdcId: number, foodNutrients: unknown[]) {
  return {
    dataType: "Foundation",
    fdcId,
    ndbNumber: 123,
    description: "Fixture food",
    publicationDate: "10/29/2026",
    foodNutrients,
  };
}

test("maps named per-100-g amounts without treating carbohydrate by difference as available", () => {
  const records = mapFoundationFoods({
    FoundationFoods: [
      food(20, [
        nutrient(2048, "kcal", 37),
        nutrient(2047, "kcal", 40),
        nutrient(1008, "kcal", 42),
        nutrient(1003, "g", 2),
        nutrient(1004, "g", 0),
        nutrient(1005, "g", 9.4),
        nutrient(1079, "g", 1.4),
      ]),
      food(10, [nutrient(2048, "kcal", 1, 2), nutrient(2047, "kcal", 11), nutrient(1005, "g", 3)]),
      food(30, [nutrient(1008, "kcal", 22), nutrient(1079, "g", 0.2, 0.2)]),
      food(40, [nutrient(1005, "g", -0.15)]),
    ],
  });

  expect(records.map(({ fdcId, energyNutrientId }) => [fdcId, energyNutrientId])).toEqual([
    [10, 2047],
    [20, 2048],
    [30, 1008],
    [40, null],
  ]);
  expect(records[0]).toMatchObject({
    carbohydrateByDifferenceG: 3,
    nutrition: { nutrients: { kcal: 11, availableCarbohydratesG: null, fiberG: null } },
  });
  expect(records[1]).toMatchObject({
    fdcId: 20,
    ndbNumber: 123,
    publicationDate: "10/29/2026",
    nutrition: {
      basis: "per-100-g",
      nutrients: { kcal: 37, proteinG: 2, availableCarbohydratesG: null, fatG: 0, fiberG: 1.4 },
    },
    carbohydrateByDifferenceG: 9.4,
  });
  expect(records[2]).toMatchObject({
    nutrition: { nutrients: { kcal: 22, availableCarbohydratesG: null, fiberG: null } },
    sourceMeasurements: expect.arrayContaining([
      { nutrientId: 1079, unit: "G", amount: 0.2, quantificationLimit: 0.2, derivationCode: "A" },
    ]),
  });
  expect(records[3]?.nutrition.nutrients).toEqual({
    kcal: null,
    proteinG: null,
    availableCarbohydratesG: null,
    fatG: null,
    fiberG: null,
  });
  expect(records[3]).toMatchObject({
    carbohydrateByDifferenceG: null,
    sourceMeasurements: [{ nutrientId: 1005, amount: -0.15 }],
  });
});

test("rejects a substituted archive and ambiguous or incorrectly labeled source records", () => {
  expect(() => previewFoundationArchive(new Uint8Array(696866))).toThrow("pinned release");
  expect(() => mapFoundationFoods({ FoundationFoods: [food(20, []), food(20, [])] })).toThrow(
    "Duplicate Foundation Foods FDC ID",
  );
  expect(() =>
    mapFoundationFoods({ FoundationFoods: [food(20, [nutrient(2048, "kJ", 165)])] }),
  ).toThrow("Invalid or duplicate nutrient 2048");
  expect(() =>
    mapFoundationFoods({
      FoundationFoods: [food(20, [nutrient(1004, "g", 4), nutrient(1004, "g", 5)])],
    }),
  ).toThrow("Invalid or duplicate nutrient 1004");
});

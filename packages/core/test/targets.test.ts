import { expect, it } from "vitest";
import {
  type CalculatedTargetInput,
  calculateNutritionTarget,
  manualNutritionTarget,
} from "../src/index.ts";

const input: CalculatedTargetInput = {
  weightKg: 80,
  heightCm: 180,
  ageYears: 30,
  formulaSex: "male",
  activityFactor: 1.5,
  goalAdjustmentKcal: -250,
  proteinG: 150,
  fatG: 80,
};

it("calculates energy for either equation constant and fills the carbohydrate budget", () => {
  expect(calculateNutritionTarget(input)).toEqual({
    kcal: 2420,
    proteinG: 150,
    fatG: 80,
    availableCarbohydratesG: 275,
  });
  expect(calculateNutritionTarget({ ...input, formulaSex: "female" })).toEqual({
    kcal: 2171,
    proteinG: 150,
    fatG: 80,
    availableCarbohydratesG: 212.75,
  });
});

it("rejects invalid inputs and macro targets that exceed the energy budget", () => {
  expect(() => calculateNutritionTarget({ ...input, goalAdjustmentKcal: -3000 })).toThrow(
    /energy/i,
  );
  expect(() => calculateNutritionTarget({ ...input, proteinG: 1000 })).toThrow(/exceed/i);
  expect(() => calculateNutritionTarget({ ...input, activityFactor: 0.8 })).toThrow(/activity/i);
  expect(() => calculateNutritionTarget({ ...input, ageYears: 17 })).toThrow(/age/i);
});

it("fills the remaining budget after the user's manual energy, protein and fat targets", () => {
  const target = { kcal: 2000, proteinG: 110, fatG: 60 };
  const saved = manualNutritionTarget(target);
  target.kcal = 2100;
  expect(saved).toEqual({ ...target, kcal: 2000, availableCarbohydratesG: 255 });
  expect(() => manualNutritionTarget({ ...target, fatG: -1 })).toThrow(/fat/i);
});

it("accepts exact decimal macro budgets without floating-point underflow", () => {
  const manual = { kcal: 1390, proteinG: 90.1, fatG: 114.4 };
  expect(manualNutritionTarget(manual)).toEqual({ ...manual, availableCarbohydratesG: 0 });
  expect(
    calculateNutritionTarget({ ...input, goalAdjustmentKcal: -1280, proteinG: 90.1, fatG: 114.4 }),
  ).toEqual({ ...manual, availableCarbohydratesG: 0 });
  expect(() => manualNutritionTarget({ ...manual, fatG: 114.40001 })).toThrow(/exceed/i);
  const otherDirection = { kcal: 1233, proteinG: 50.4, fatG: 114.6 };
  expect(manualNutritionTarget(otherDirection)).toEqual({
    ...otherDirection,
    availableCarbohydratesG: 0,
  });
});

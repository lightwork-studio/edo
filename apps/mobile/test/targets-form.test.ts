import { expect, test } from "vitest";
import { previewTarget, type TargetsDraft } from "../src/targets-form";

const calculated: TargetsDraft = {
  mode: "calculated",
  kcal: "",
  weight: "78,6",
  height: "182",
  age: "34",
  coefficient: "male",
  activity: "1,5",
  adjustment: "−250,5",
  protein: "150",
  fat: "70",
};

test("previews maintenance, a signed local goal adjustment and remaining carbs", () => {
  expect(previewTarget(calculated)).toEqual({
    maintenanceKcal: 2638,
    kcal: 2387,
    weightKg: 78.6,
    target: { kcal: 2387, proteinG: 150, fatG: 70, availableCarbohydratesG: 289.25 },
    error: null,
  });
  expect(previewTarget({ ...calculated, adjustment: "+250" }).kcal).toBe(2888);
  expect(previewTarget({ ...calculated, adjustment: "0" }).kcal).toBe(2638);
  expect(previewTarget({ ...calculated, adjustment: "" })).toMatchObject({
    maintenanceKcal: 2638,
    kcal: null,
    target: null,
    error: "invalidAdjustment",
  });
  expect(previewTarget({ ...calculated, weight: "0" }).error).toBe("invalidBody");
  expect(previewTarget({ ...calculated, coefficient: null }).error).toBe("invalidBody");
});

test("requires explicit manual calories and macros, allowing zero grams and zero remaining carbs", () => {
  const manual: TargetsDraft = { ...calculated, mode: "manual", kcal: "600", fat: "0" };
  expect(previewTarget(manual).target).toEqual({
    kcal: 600,
    proteinG: 150,
    fatG: 0,
    availableCarbohydratesG: 0,
  });
  expect(previewTarget({ ...manual, kcal: "0" }).error).toBe("invalidCalories");
  expect(previewTarget({ ...manual, fat: "" }).error).toBe("invalidMacros");
  expect(previewTarget({ ...manual, fat: "−1" }).error).toBe("invalidMacros");
  expect(previewTarget({ ...manual, fat: "0,1" }).error).toBe("overBudget");
});

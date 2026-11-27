import {
  type CalculatedTargetInput,
  calculateNutritionTarget,
  type DailyNutritionTarget,
  manualNutritionTarget,
} from "@edo/core";
import type { NutritionTargetRecord } from "@edo/storage";

export interface TargetsDraft {
  mode: NutritionTargetRecord["mode"];
  kcal: string;
  savedCalculatedKcal: number | null;
  weight: string;
  height: string;
  age: string;
  coefficient: CalculatedTargetInput["formulaSex"] | null;
  activity: string;
  adjustment: string;
  protein: string;
  fat: string;
}

type InvalidEnergy = "invalidCalories" | "invalidBody" | "invalidAdjustment";
type EnergyPreview = {
  maintenanceKcal: number | null;
} & ({ kcal: number; error: null } | { kcal: null; error: InvalidEnergy });

function readNumber(text: string): number | null {
  const normalized = text.trim().replace("−", "-").replace(",", ".");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function previewEnergy(draft: TargetsDraft): EnergyPreview {
  if (draft.mode === "manual") {
    const kcal = readNumber(draft.kcal);
    return kcal !== null && kcal > 0
      ? { maintenanceKcal: null, kcal, error: null }
      : { maintenanceKcal: null, kcal: null, error: "invalidCalories" };
  }
  if (draft.savedCalculatedKcal !== null) {
    return { maintenanceKcal: null, kcal: draft.savedCalculatedKcal, error: null };
  }

  const weightKg = readNumber(draft.weight);
  const heightCm = readNumber(draft.height);
  const ageYears = readNumber(draft.age);
  const activityFactor = readNumber(draft.activity);
  const formulaSex = draft.coefficient;
  if (
    weightKg === null ||
    heightCm === null ||
    ageYears === null ||
    !formulaSex ||
    activityFactor === null
  ) {
    return { maintenanceKcal: null, kcal: null, error: "invalidBody" };
  }

  const inputs = { weightKg, heightCm, ageYears, activityFactor, formulaSex, proteinG: 0, fatG: 0 };
  let maintenanceKcal: number;
  try {
    maintenanceKcal = calculateNutritionTarget({ ...inputs, goalAdjustmentKcal: 0 }).kcal;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { maintenanceKcal: null, kcal: null, error: "invalidBody" };
  }

  const goalAdjustmentKcal = readNumber(draft.adjustment);
  if (goalAdjustmentKcal !== null) {
    try {
      const { kcal } = calculateNutritionTarget({ ...inputs, goalAdjustmentKcal });
      return { maintenanceKcal, kcal, error: null };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return { maintenanceKcal, kcal: null, error: "invalidAdjustment" };
}

type TargetPreview = {
  kcal: number | null;
  maintenanceKcal: number | null;
  weightKg: number | null;
} & (
  | { target: DailyNutritionTarget; error: null }
  | { target: null; error: InvalidEnergy | "invalidMacros" | "overBudget" }
);

export function previewTarget(draft: TargetsDraft): TargetPreview {
  const energy = previewEnergy(draft);
  const preview = { kcal: energy.kcal, maintenanceKcal: energy.maintenanceKcal, weightKg: null };
  if (energy.error) return { ...preview, target: null, error: energy.error };

  const proteinG = readNumber(draft.protein);
  const fatG = readNumber(draft.fat);
  if (proteinG === null || proteinG < 0 || fatG === null || fatG < 0) {
    return { ...preview, target: null, error: "invalidMacros" };
  }
  try {
    const target = manualNutritionTarget({ kcal: energy.kcal, proteinG, fatG });
    const weightKg =
      draft.mode === "calculated" && draft.savedCalculatedKcal === null
        ? readNumber(draft.weight)
        : null;
    return { ...preview, weightKg, target, error: null };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { ...preview, target: null, error: "overBudget" };
  }
}

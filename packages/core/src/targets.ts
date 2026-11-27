export interface ManualTargetInput {
  readonly kcal: number;
  readonly proteinG: number;
  readonly fatG: number;
}

export interface DailyNutritionTarget extends ManualTargetInput {
  readonly availableCarbohydratesG: number;
}

export interface CalculatedTargetInput {
  readonly weightKg: number;
  readonly heightCm: number;
  readonly ageYears: number;
  /** Selects the constant used by the published equation. */
  readonly formulaSex: "female" | "male";
  readonly activityFactor: number;
  readonly goalAdjustmentKcal: number;
  readonly proteinG: number;
  readonly fatG: number;
}

function requireAtLeast(value: number, minimum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${label} must be finite and at least ${minimum}`);
  }
}

function requirePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive`);
  }
}

/** Use the selected calorie, protein and fat targets and fill the remaining budget with carbs. */
export function manualNutritionTarget(input: ManualTargetInput): DailyNutritionTarget {
  const { kcal, proteinG, fatG } = input;
  requirePositive(kcal, "Energy target");
  requireAtLeast(proteinG, 0, "Protein");
  requireAtLeast(fatG, 0, "Fat");
  const proteinAndFatKcal = proteinG * 4 + fatG * 9;
  if (!Number.isFinite(proteinAndFatKcal))
    throw new RangeError("Protein and fat exceed the energy target");
  const remainder = kcal - proteinAndFatKcal;
  const precision = Number.EPSILON * Math.max(kcal, proteinAndFatKcal);
  if (remainder < -precision) throw new RangeError("Protein and fat exceed the energy target");
  const availableCarbohydratesG = remainder <= precision ? 0 : remainder / 4;
  return { kcal, proteinG, fatG, availableCarbohydratesG };
}

/**
 * Estimates daily energy from the Mifflin–St Jeor resting equation and explicit activity
 * and goal inputs. Protein and fat are entered in grams, and carbohydrate fills the budget.
 * https://pubmed.ncbi.nlm.nih.gov/2305711/
 */
export function calculateNutritionTarget(input: CalculatedTargetInput): DailyNutritionTarget {
  const { weightKg, heightCm, ageYears, formulaSex, activityFactor, goalAdjustmentKcal } = input;
  requirePositive(weightKg, "Weight");
  requirePositive(heightCm, "Height");
  if (!Number.isSafeInteger(ageYears) || ageYears < 18) {
    throw new RangeError("Calculated targets require an adult age in whole years");
  }
  if (formulaSex !== "female" && formulaSex !== "male") {
    throw new TypeError("Select the constant for the resting energy equation");
  }
  requireAtLeast(activityFactor, 1, "Activity factor");
  if (!Number.isFinite(goalAdjustmentKcal)) throw new RangeError("Enter a finite goal adjustment");

  const restingKcal =
    10 * weightKg + 6.25 * heightCm - 5 * ageYears + (formulaSex === "male" ? 5 : -161);
  requirePositive(restingKcal, "Estimated resting energy");
  const kcal = Math.round(restingKcal * activityFactor + goalAdjustmentKcal);
  const { proteinG, fatG } = input;
  return manualNutritionTarget({ kcal, proteinG, fatG });
}

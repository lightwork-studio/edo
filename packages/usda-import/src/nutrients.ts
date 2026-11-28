export const carbohydrateByDifference = 1005;
const energyPreference = [2048, 2047, 1008];
type Unit = "G" | "KCAL";

export const units: ReadonlyMap<number, Unit> = new Map([
  [1003, "G"],
  [1004, "G"],
  [carbohydrateByDifference, "G"],
  [1079, "G"],
  ...energyPreference.map((id) => [id, "KCAL"] as const),
]);

export interface Measurement {
  readonly nutrientId: number;
  readonly unit: Unit;
  readonly amount: number | null;
  readonly quantificationLimit: number | null;
  readonly derivationCode: string | null;
}

export function previewNutrition(measurements: ReadonlyMap<number, Measurement>) {
  function quantified(nutrientId: number): number | null {
    const observed = measurements.get(nutrientId);
    if (!observed || observed.amount === null || observed.amount < 0) return null;
    const { amount, quantificationLimit } = observed;
    return quantificationLimit !== null && quantificationLimit > 0 && amount <= quantificationLimit
      ? null
      : amount;
  }

  const energyNutrientId = energyPreference.find((id) => quantified(id) !== null) ?? null;
  return {
    nutrition: {
      basis: "per-100-g",
      nutrients: {
        kcal: energyNutrientId === null ? null : quantified(energyNutrientId),
        proteinG: quantified(1003),
        availableCarbohydratesG: null,
        fatG: quantified(1004),
        fiberG: quantified(1079),
      },
    },
    carbohydrateByDifferenceG: quantified(carbohydrateByDifference),
    energyNutrientId,
    sourceMeasurements: [...measurements.values()].sort((a, b) => a.nutrientId - b.nutrientId),
  };
}

import { type Nutrients, sevenDayWeightAverage, type WeighIn } from "@edo/core";
import type { DiaryProgressStore, DiaryStore } from "@edo/storage";
import { addDays, calendarDate, totalNutrition } from "./diary-view.ts";

export type ProgressRange = 7 | 30 | 90;

export interface WeightPoint {
  readonly day: string;
  readonly measured: WeighIn | null;
  readonly averageKg: number | null;
}

export function weightWindowStart(through: string, days: number): string {
  const first = addDays(through, 1 - days);
  return first < "0000-01-01" ? "0000-01-01" : first;
}

export function recentWeightEnd(today: string): string {
  // The time zones at either side of the date line can differ by 26 hours.
  return addDays(today, 2);
}

export function weightPoints(
  today: string,
  days: ProgressRange,
  weighIns: readonly WeighIn[],
): WeightPoint[] {
  const recent = new Map<string, WeighIn>();
  for (const record of weighIns) {
    const known = recent.get(record.localDay);
    if (
      !known ||
      record.occurredAt > known.occurredAt ||
      (record.occurredAt === known.occurredAt && record.id > known.id)
    ) {
      recent.set(record.localDay, record);
    }
  }
  const readings = [...recent.values()];
  return Array.from({ length: days }, (_, index) => {
    const day = addDays(today, index + 1 - days);
    const start = weightWindowStart(day, 7);
    const window = readings.filter((entry) => entry.localDay >= start && entry.localDay <= day);
    return {
      day,
      measured: recent.get(day) ?? null,
      averageKg: sevenDayWeightAverage(day, window).kg,
    };
  });
}

function measuredMean(values: readonly (number | null)[]): number | null {
  if (values.length === 0) return null;
  let mean = 0;
  for (const [index, value] of values.entries()) {
    if (value === null) return null;
    mean += (value - mean) / (index + 1);
  }
  return mean;
}

export function progressSummary(
  diary: Pick<DiaryStore, "listMeals"> &
    Pick<DiaryProgressStore, "listWeighIns" | "nutritionTargetAt">,
  today: string,
  range: ProgressRange,
) {
  const weights = diary.listWeighIns(weightWindowStart(today, range + 6), recentWeightEnd(today));
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = addDays(today, index - 6);
    const meals = diary.listMeals(day);
    const hasMeals = meals.some((meal) => meal.items.length > 0);
    return {
      day,
      nutrition: hasMeals ? totalNutrition(meals) : null,
      hasMeals,
      target: diary.nutritionTargetAt(day),
    };
  });
  const completed = days.filter((entry) => entry.day !== today && entry.hasMeals);
  const mean = (key: keyof Nutrients) =>
    measuredMean(completed.map((entry) => entry.nutrition?.[key] ?? null));
  const proteinChecks = completed.flatMap(({ nutrition, target }) => {
    const grams = nutrition?.proteinG;
    return grams != null && target ? [grams >= target.target.proteinG] : [];
  });
  return {
    days,
    points: weightPoints(today, range, weights),
    latestWeight: weights.at(-1) ?? null,
    averageCalories: mean("kcal"),
    averageMacros: {
      proteinG: mean("proteinG"),
      availableCarbohydratesG: mean("availableCarbohydratesG"),
      fatG: mean("fatG"),
    },
    proteinTargetDays: proteinChecks.length,
    proteinHits: proteinChecks.filter(Boolean).length,
  };
}

export function validWeighInDay(value: string, today: string): string | null {
  const day = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today) return null;
  const date = calendarDate(day);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}

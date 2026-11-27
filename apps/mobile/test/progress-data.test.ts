import { createDiaryItem, type Food, type WeighIn } from "@edo/core";
import { expect, it } from "vitest";
import {
  progressSummary,
  validWeighInDay,
  weightPoints,
  weightWindowStart,
} from "../src/progress-data.ts";

const today = "2026-11-27";
const calculatedEarlier = "2026-11-25";
const changedDay = "2026-11-26";
const food: Food = {
  id: { provider: "bls", sourceId: "synthetic-food" },
  name: "Synthetic grain",
  release: "fixture",
  preparation: "raw",
  nutrition: {
    basis: "per-100-g",
    nutrients: { kcal: 80, proteinG: 10, availableCarbohydratesG: 12, fatG: 2, fiberG: null },
  },
};

it("plots the latest measurement per day and leaves gaps in the moving average", () => {
  const weights: WeighIn[] = [
    { id: "first", localDay: "2026-11-20", occurredAt: 1, kg: 80 },
    { id: "earlier", localDay: "2026-11-23", occurredAt: 2, kg: 90 },
    { id: "newer", localDay: "2026-11-23", occurredAt: 3, kg: 82 },
  ];
  const points = weightPoints(today, 7, weights);
  expect(points[0]).toEqual({ day: "2026-11-21", measured: null, averageKg: null });
  expect(points[2]).toEqual({ day: "2026-11-23", measured: weights[2], averageKg: 81 });
  expect(points[3]).toEqual({ day: "2026-11-24", measured: null, averageKg: 81 });
  expect(points.at(-1)).toEqual({ day: today, measured: null, averageKg: null });
});

it("uses historical targets and excludes incomplete today from completed-day summaries", () => {
  const diary: Parameters<typeof progressSummary>[0] = {
    listMeals(day) {
      if (day === "2026-11-24") return [{ id: "empty", localDay: day, occurredAt: 0, items: [] }];
      if (![calculatedEarlier, changedDay, today].includes(day)) return [];
      const missingProtein = {
        ...food,
        nutrition: {
          ...food.nutrition,
          nutrients: { ...food.nutrition.nutrients, proteinG: null },
        },
      };
      return [
        {
          id: day,
          localDay: day,
          occurredAt: 0,
          items: [
            createDiaryItem(day, day === changedDay ? missingProtein : food, {
              amount: day === today ? 200 : 100,
              unit: "g",
            }),
          ],
        },
      ];
    },
    listWeighIns: () => [],
    nutritionTargetAt(day) {
      const earlier = day < changedDay;
      return {
        id: earlier ? "earlier-target" : "later-target",
        effectiveDay: earlier ? calculatedEarlier : changedDay,
        configuredAt: 0,
        mode: "manual",
        target: { kcal: 100, proteinG: earlier ? 9 : 20, availableCarbohydratesG: 10, fatG: 2 },
      };
    },
  };
  const summary = progressSummary(diary, today, 7);
  expect(summary.days.at(-1)?.nutrition?.kcal).toBe(160);
  expect(summary.averageCalories).toBe(80);
  expect(summary.averageMacros).toEqual({ proteinG: null, availableCarbohydratesG: 12, fatG: 2 });
  expect(summary.proteinTargetDays).toBe(1);
  expect(summary.proteinHits).toBe(1);
});

it("validates a recorded calendar day without converting through the device time zone", () => {
  expect(validWeighInDay(" 2024-02-29 ", today)).toBe("2024-02-29");
  expect(validWeighInDay("2026-02-29", today)).toBeNull();
  expect(validWeighInDay("2026-11-28", today)).toBeNull();
  expect(weightWindowStart("2026-08-01", 7)).toBe("2026-07-26");
  expect(weightWindowStart("0000-01-01", 7)).toBe("0000-01-01");
});

it("keeps a reading visible after crossing the date line without moving today's trend", () => {
  const earlier: WeighIn = {
    id: "earlier",
    localDay: "2026-11-26",
    occurredAt: Date.parse("2026-11-26T08:00:00Z"),
    kg: 82,
  };
  const prior: WeighIn = {
    id: "prior",
    localDay: today,
    occurredAt: Date.parse("2026-11-27T08:00:00Z"),
    kg: 80,
  };
  const afterTravel: WeighIn = {
    id: "captured-in-an-eastern-zone",
    localDay: "2026-11-29",
    occurredAt: Date.parse("2026-11-28T10:30:00Z"),
    kg: 78,
  };
  const summary = progressSummary(
    {
      listMeals: () => [],
      listWeighIns: (from, through) =>
        [earlier, prior, afterTravel].filter(
          (record) => record.localDay >= from && record.localDay <= through,
        ),
      nutritionTargetAt: () => null,
    },
    today,
    7,
  );
  expect(summary.latestWeight).toEqual(afterTravel);
  expect(summary.points.at(-1)).toEqual({ day: today, measured: prior, averageKg: 81 });
});

import { createDiaryItem, type DiaryMeal, type Food } from "@edo/core";
import { expect, it } from "vitest";
import { mealTemplateOptions, selectedMealItems } from "../src/meal-template-form.ts";

const food: Food = {
  id: { provider: "local", sourceId: "tofu" },
  release: null,
  name: "Tofu",
  preparation: "as-sold",
  nutrition: {
    basis: "per-100-g",
    nutrients: { kcal: 150, proteinG: 17, availableCarbohydratesG: 2, fatG: 9, fiberG: null },
  },
};

function loggedMeal(id: string, localDay: string, hour: string, amounts: readonly number[]) {
  return {
    id,
    localDay,
    occurredAt: Date.parse(`${localDay}T${hour}:00:00Z`),
    items: amounts.map((amount, index) =>
      createDiaryItem(`${id}-${index}`, food, { amount, unit: "g" }),
    ),
  } satisfies DiaryMeal;
}

it("offers the diary day's saved snapshots and keeps diary order when combining foods", () => {
  const yesterday = loggedMeal("yesterday", "2026-11-26", "12", [50]);
  const breakfast = loggedMeal("breakfast", "2026-11-27", "08", [125]);
  const lunch = loggedMeal("lunch", "2026-11-27", "12", [150, 30]);
  const dinner = loggedMeal("dinner", "2026-11-27", "18", [200]);
  const options = mealTemplateOptions(lunch, [yesterday, breakfast, lunch, dinner]);

  expect(options.map(({ occurredAt }) => occurredAt)).toEqual([
    breakfast.occurredAt,
    lunch.occurredAt,
    lunch.occurredAt,
    dinner.occurredAt,
  ]);
  const initiallySelected = options.filter((option) => option.initiallySelected);
  expect(initiallySelected.map(({ item }) => item)).toEqual(lunch.items);
  const items = selectedMealItems(options, new Set(["dinner-0", "lunch-1", "breakfast-0"]));
  expect(items).toEqual([breakfast.items[0], lunch.items[1], dinner.items[0]]);
  expect(items[0]).toBe(breakfast.items[0]);
  expect(selectedMealItems(options, new Set())).toEqual([]);
});

it("retains the separate capture offsets when two items share a repeated wall time", () => {
  const first = {
    ...loggedMeal("first", "2026-11-01", "05", [25.125]),
    utcOffsetMinutes: -240,
  };
  const second = {
    ...loggedMeal("second", "2026-11-01", "06", [75]),
    utcOffsetMinutes: -300,
  };
  const options = mealTemplateOptions(second, [first, second]);
  expect(options.map(({ utcOffsetMinutes }) => utcOffsetMinutes)).toEqual([-240, -300]);
  expect(options[0]?.item.portion.amount).toBe(25.125);
  expect(options[1]?.initiallySelected).toBe(true);
});

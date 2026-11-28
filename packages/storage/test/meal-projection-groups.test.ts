import { createDiaryItem, type DiaryMeal, type Food, updateDiaryPortion } from "@edo/core";
import { expect, test } from "vitest";
import { groupMealProjections } from "../src/meal-projection-groups.ts";

const food: Food = {
  id: { provider: "local", sourceId: "soup" },
  name: "Soup",
  release: null,
  preparation: "unknown",
  nutrition: {
    basis: "per-100-g",
    nutrients: { kcal: 70, proteinG: 3, availableCarbohydratesG: 5, fatG: 4, fiberG: null },
  },
};
const first = createDiaryItem("first-item", food, { amount: 100, unit: "g" });
const second = createDiaryItem("second-item", food, { amount: 150, unit: "g" });

function meal(id: string, items: DiaryMeal["items"]): DiaryMeal {
  return {
    id,
    localDay: "2026-11-27",
    occurredAt: Date.parse("2026-11-27T13:00:00Z"),
    utcOffsetMinutes: 60,
    items,
  };
}

const mealA = meal("a", [first]);
const mealB = meal("b", [second]);
const owners = new Map([
  [first.id, mealA.id],
  [second.id, mealB.id],
]);

test("groups a server swap against both complete known local meals", () => {
  const result = groupMealProjections(
    [
      { id: "a", current: mealA, prior: mealA, incoming: meal("a", [second]) },
      { id: "b", current: mealB, prior: mealB, incoming: meal("b", [first]) },
    ],
    owners,
  );
  expect(result).toEqual({ groups: [["a", "b"]], deferred: [] });
});

test("defers a whole connected transfer if a local meal changed outside the journal", () => {
  const result = groupMealProjections(
    [
      {
        id: "a",
        current: meal("a", [updateDiaryPortion(first, { amount: 200, unit: "g" })]),
        prior: mealA,
        incoming: meal("a", [second]),
      },
      { id: "b", current: mealB, prior: mealB, incoming: meal("b", [first]) },
      { id: "new-meal", current: null, prior: undefined, incoming: meal("new-meal", []) },
    ],
    owners,
  );
  expect(result).toEqual({ groups: [["new-meal"]], deferred: ["a", "b"] });
});

test("preserves local deletions and differing legacy meals while adopting exact matches", () => {
  const matched = meal("legacy-matched", []);
  const legacyRemoved = meal("legacy-removed", []);
  const result = groupMealProjections(
    [
      { id: "a", current: null, prior: mealA, incoming: meal("a", []) },
      { id: "b", current: mealB, prior: undefined, incoming: meal("b", []) },
      { id: matched.id, current: matched, prior: undefined, incoming: matched },
      {
        id: legacyRemoved.id,
        current: null,
        prior: undefined,
        hadPriorBase: true,
        incoming: legacyRemoved,
      },
      { id: "deleted", current: null, prior: null, incoming: meal("deleted", []) },
    ],
    owners,
  );
  expect(result).toEqual({
    groups: [[matched.id]],
    deferred: ["a", "b", legacyRemoved.id, "deleted"],
  });
});

test("waits for a current owner and declines inconsistent duplicate latest claims", () => {
  const incoming = [
    { id: "b", current: mealB, prior: mealB, incoming: meal("b", [first]) },
    { id: "new", current: null, prior: undefined, incoming: meal("new", [first]) },
  ];
  expect(groupMealProjections(incoming.slice(0, 1), owners)).toEqual({
    groups: [],
    deferred: ["b"],
  });
  expect(groupMealProjections(incoming, new Map())).toEqual({
    groups: [],
    deferred: ["b", "new"],
  });
});

test("does not adopt a matching tombstone after an unjournaled item removal", () => {
  const result = groupMealProjections(
    [
      { id: "a", current: null, prior: mealA, incoming: null },
      {
        id: "destination",
        current: null,
        prior: undefined,
        incoming: meal("destination", [first]),
      },
    ],
    new Map(),
  );
  expect(result).toEqual({ groups: [], deferred: ["a", "destination"] });
});

test("keeps ownership changes with opaque claims and permits an unrelated metadata edit", () => {
  const cleanMetadata = { ...mealB, occurredAt: mealB.occurredAt + 60_000 };
  const source = { id: mealA.id, current: mealA, prior: mealA, incoming: meal("a", []) };
  const independent = { id: mealB.id, current: mealB, prior: mealB, incoming: cleanMetadata };
  const opaque = { id: "future", current: null, prior: undefined, incoming: undefined };
  const expected = { groups: [[mealB.id]], deferred: [mealA.id, opaque.id] };
  expect(
    groupMealProjections([source, independent, { ...opaque, opaqueClaims: [first.id] }], owners),
  ).toEqual(expected);
  expect(groupMealProjections([source, independent, opaque], owners)).toEqual(expected);
});

test("retained observations can defer a move even without a new copy of its former owner", () => {
  const destination = {
    id: "new",
    current: null,
    prior: undefined,
    incoming: meal("new", [first]),
  };
  const unrelated = {
    id: mealB.id,
    current: mealB,
    prior: mealB,
    incoming: { ...mealB, occurredAt: mealB.occurredAt + 60_000 },
  };
  const candidates = [destination, unrelated];
  const expected = { groups: [[mealB.id]], deferred: [destination.id] };
  expect(
    groupMealProjections(candidates, new Map(), [
      { id: mealA.id, itemIds: [first.id], unknownPrior: false },
    ]),
  ).toEqual(expected);
  expect(
    groupMealProjections(candidates, new Map(), [
      { id: mealA.id, itemIds: [], unknownPrior: true },
    ]),
  ).toEqual(expected);
  expect(groupMealProjections(candidates, new Map())).toEqual({
    groups: [[destination.id], [mealB.id]],
    deferred: [],
  });
});

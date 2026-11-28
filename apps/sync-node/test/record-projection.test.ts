import { type JsonObject, syncCandidate } from "@edo/contract";
import { expect, it } from "vitest";
import { applyRecordContent } from "../src/record-projection.ts";
import { InvalidSyncContent } from "../src/sync-store.ts";

const nutrients = {
  kcal: 120,
  proteinG: null,
  availableCarbohydratesG: 0,
  fatG: 6.1,
  fiberG: null,
};
const food = {
  id: { provider: "open-food-facts", sourceId: "00123" },
  name: "Synthetic food",
  release: "fixture-release",
  preparation: "as-sold",
  nutrition: { basis: "per-100-g", nutrients },
};
const item = {
  id: "item-1",
  food,
  portion: { amount: 100, unit: "g" },
  nutrients,
};
const meal = {
  id: "meal-1",
  localDay: "2026-11-27",
  occurredAt: 1_795_780_800_000,
  items: [item],
};
const args = { key: { kind: "meal", id: "meal-1" }, release: syncCandidate.release };

it("merges known fields and retains unknown parts attached to the same nested item ID", () => {
  const olderEdit = {
    ...meal,
    items: [
      {
        ...item,
        portion: { amount: 50, unit: "g" },
        nutrients: { ...nutrients, kcal: 60, fatG: 3.05 },
      },
    ],
  };
  const current = {
    ...meal,
    futureInfo: { count: 0, active: false },
    items: [
      {
        ...item,
        futureFlag: null,
        food: { ...food, nutrition: { ...food.nutrition, futureBasis: "x" } },
      },
      { ...item, id: "other-item", futureFlag: "deleted with its item" },
    ],
  };
  const updated = applyRecordContent({ ...args, current, submitted: olderEdit });
  expect(updated).toEqual({
    ...olderEdit,
    futureInfo: current.futureInfo,
    items: [
      {
        ...olderEdit.items[0],
        futureFlag: null,
        food: { ...food, nutrition: { ...food.nutrition, futureBasis: "x" } },
      },
    ],
  });
  const sameOpaqueWithReorderedKeys = { ...olderEdit, futureInfo: { active: false, count: 0 } };
  expect(applyRecordContent({ ...args, current, submitted: sameOpaqueWithReorderedKeys })).toEqual(
    updated,
  );
  expect(() =>
    applyRecordContent({
      ...args,
      current,
      submitted: { ...olderEdit, futureInfo: { count: 1, active: false } },
    }),
  ).toThrow(InvalidSyncContent);
});

it("rejects invalid snapshots, conflicting identity and unsupported new fields", () => {
  const bad: JsonObject[] = [
    { ...meal, id: "another-record" },
    { ...meal, localDay: "2026-02-30" },
    { ...meal, items: [item, item] },
    { ...meal, items: [{ ...item, portion: { amount: 0, unit: "g" } }] },
    { ...meal, items: [{ ...item, nutrients: { ...nutrients, fiberG: -1 } }] },
    { ...meal, acknowledgedNever: true },
  ];
  for (const submitted of bad) {
    expect(() => applyRecordContent({ ...args, current: null, submitted })).toThrow(
      InvalidSyncContent,
    );
  }
  expect(applyRecordContent({ ...args, current: null, submitted: meal })).toEqual(meal);
  expect(() =>
    applyRecordContent({ ...args, release: "9.9", current: null, submitted: meal }),
  ).toThrow(InvalidSyncContent);
});

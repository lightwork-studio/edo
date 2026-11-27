import { expect, it } from "vitest";
import {
  createDiaryItem,
  type DiaryMeal,
  type Food,
  reconcileDiaryMeal,
  updateDiaryPortion,
} from "../src/index.ts";

const food: Food = {
  id: { provider: "bls", sourceId: "synthetic" },
  name: "Synthetic food",
  preparation: "raw",
  release: "source-1",
  nutrition: {
    basis: "per-100-g",
    nutrients: { kcal: 60, proteinG: 2, availableCarbohydratesG: 10, fatG: 1, fiberG: null },
  },
};

const a = createDiaryItem("a", food, { amount: 100, unit: "g" });
const b = createDiaryItem("b", food, { amount: 200, unit: "g" });
const c = createDiaryItem("c", food, { amount: 150, unit: "g" });
const d = createDiaryItem("d", food, { amount: 50, unit: "g" });
const base: DiaryMeal = {
  id: "meal",
  localDay: "2026-11-25",
  occurredAt: Date.parse("2026-11-25T12:00:00Z"),
  items: [a, b],
};

it("reconciles independent edits by stable item ID and keeps each captured snapshot whole", () => {
  const smaller = updateDiaryPortion(a, { amount: 50, unit: "g" });
  const withReportedFiber = { ...b, nutrients: { ...b.nutrients, fiberG: 2 } };
  const local = { ...base, items: [smaller, b] };
  const server = { ...base, items: [a, withReportedFiber] };
  expect(
    reconcileDiaryMeal(structuredClone(base), structuredClone(local), structuredClone(server)),
  ).toEqual({
    status: "merged",
    meal: { ...base, items: [smaller, withReportedFiber] },
  });
});

it("keeps both sides of an overlapping snapshot edit or an edit against deletion", () => {
  const local = { ...base, items: [updateDiaryPortion(a, { amount: 50, unit: "g" }), b] };
  const changed = { ...base, items: [{ ...a, nutrients: { ...a.nutrients, kcal: 62 } }, b] };
  const deleted = { ...base, items: [b] };
  for (const server of [changed, deleted]) {
    expect(reconcileDiaryMeal(base, local, server)).toEqual({
      status: "conflict",
      conflicts: [{ kind: "item", id: "a" }],
      base,
      local,
      server,
    });
  }
  expect(reconcileDiaryMeal(base, local, null)).toMatchObject({
    status: "conflict",
    conflicts: [{ kind: "record" }],
    server: null,
    local,
  });
  expect(reconcileDiaryMeal(base, base, null)).toEqual({ status: "merged", meal: null });
});

it("preserves each side's insertion placement and orders unrelated inserts by stable ID", () => {
  const local = { ...base, items: [a, d, b] };
  const server = { ...base, items: [a, c, b] };
  const expected = { status: "merged", meal: { ...base, items: [a, c, d, b] } };
  expect(reconcileDiaryMeal(base, local, server)).toEqual(expected);
  expect(reconcileDiaryMeal(base, server, local)).toEqual(expected);
});

it("returns incompatible orderings for review when their combined constraints form a cycle", () => {
  const original = { ...base, items: [a, b, c] };
  const local = { ...original, items: [b, a, c] };
  const server = { ...original, items: [a, c, b] };
  expect(reconcileDiaryMeal(original, local, server)).toMatchObject({
    status: "conflict",
    conflicts: [{ kind: "item-order" }],
    local,
    server,
  });
  expect(reconcileDiaryMeal(original, local, original)).toEqual({ status: "merged", meal: local });
});

it("reports conflicting order alongside different times and retained item changes", () => {
  const original = { ...base, items: [a, b, c] };
  const local = {
    ...original,
    occurredAt: original.occurredAt - 3_600_000,
    items: [b, updateDiaryPortion(a, { amount: 60, unit: "g" }), c],
  };
  const server = {
    ...original,
    occurredAt: original.occurredAt + 3_600_000,
    items: [updateDiaryPortion(a, { amount: 90, unit: "g" }), c, b],
  };
  expect(reconcileDiaryMeal(original, local, server)).toEqual({
    status: "conflict",
    conflicts: [{ kind: "time" }, { kind: "item", id: "a" }, { kind: "item-order" }],
    base: original,
    local,
    server,
  });
});

it("treats deleting an item that the other side reordered as a conflict", () => {
  const local = { ...base, items: [b] };
  const server = { ...base, items: [b, a] };
  expect(reconcileDiaryMeal(base, local, server)).toMatchObject({
    status: "conflict",
    conflicts: [{ kind: "item", id: "a" }],
  });
});

it("treats the local diary date and recorded instant as a single decision", () => {
  const local = { ...base, occurredAt: base.occurredAt - 3_600_000 };
  const server = { ...base, localDay: "2026-11-24" };
  expect(reconcileDiaryMeal(base, local, server)).toMatchObject({
    status: "conflict",
    conflicts: [{ kind: "time" }],
    local,
    server,
  });
  expect(reconcileDiaryMeal(base, { ...base, items: [b] }, server)).toMatchObject({
    status: "merged",
    meal: { ...server, items: [b] },
  });
});

it("preserves the captured UTC offset from the chosen event time", () => {
  const original = { ...base, utcOffsetMinutes: -240 };
  const local = { ...original, utcOffsetMinutes: -300 };
  const server = { ...original, items: [b, a] };
  expect(reconcileDiaryMeal(original, local, server)).toEqual({
    status: "merged",
    meal: { ...local, items: [b, a] },
  });
  expect(reconcileDiaryMeal(original, local, { ...server, utcOffsetMinutes: 60 })).toMatchObject({
    status: "conflict",
    conflicts: [{ kind: "time" }],
  });
});

it("uses a known offset for a legacy copy of the same event", () => {
  const original = { ...base, utcOffsetMinutes: -240 };
  const server = { ...original, items: [a, b, c] };
  expect(reconcileDiaryMeal(original, base, server)).toEqual({
    status: "merged",
    meal: server,
  });
  expect(reconcileDiaryMeal(original, { ...base, items: [a] }, server)).toEqual({
    status: "merged",
    meal: { ...server, items: [a, c] },
  });
  const newEvent = { ...base, occurredAt: base.occurredAt + 3_600_000 };
  expect(reconcileDiaryMeal(original, newEvent, server)).toEqual({
    status: "merged",
    meal: { ...newEvent, items: [a, b, c] },
  });
});

it("rejects mixed meal IDs and duplicate item IDs before choosing either version", () => {
  expect(() => reconcileDiaryMeal(base, base, { ...base, id: "different" })).toThrow(/meal ID/);
  expect(() => reconcileDiaryMeal(base, { ...base, items: [a, a] }, base)).toThrow(/Duplicate/);
});

import { type JsonObject, type JsonValue, type RecordKey, syncCandidate } from "@edo/contract";
import {
  type DailyNutritionTarget,
  foodForRecipe,
  manualNutritionTarget,
  type Recipe,
} from "@edo/core";
import { InvalidSyncContent } from "./sync-store.ts";

type Scalar = (value: JsonValue) => boolean;
type Rule = Scalar | { fields: Shape } | { keyedItems: Shape; min: number };
type Shape = Readonly<Record<string, { rule: Rule; optional?: true }>>;

const text: Scalar = (value) => typeof value === "string" && Boolean(value.trim());
const id: Scalar = (value) =>
  typeof value === "string" &&
  Boolean(value.trim()) &&
  !value.includes("\0") &&
  !/[\uD800-\uDFFF]/u.test(value);
const positive: Scalar = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const nonNegative: Scalar = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const nutrientValue: Scalar = (value) => value === null || nonNegative(value);
const utcOffset: Scalar = (value) =>
  typeof value === "number" && Number.isInteger(value) && Math.abs(value) < 24 * 60;
const instant: Scalar = (value) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  Number.isFinite(new Date(value).valueOf());
const day: Scalar = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};
const oneOf =
  (...values: readonly string[]): Scalar =>
  (value) =>
    typeof value === "string" && values.includes(value);

function required(rule: Rule) {
  return { rule };
}
function optional(rule: Rule) {
  return { rule, optional: true as const };
}
function of(fields: Shape): Rule {
  return { fields };
}
function items(keyedItems: Shape, min = 1): Rule {
  return { keyedItems, min };
}

const nutrients = of({
  kcal: required(nutrientValue),
  proteinG: required(nutrientValue),
  availableCarbohydratesG: required(nutrientValue),
  fatG: required(nutrientValue),
  fiberG: required(nutrientValue),
});
const provider = oneOf("bls", "open-food-facts", "usda", "local");
const food: Shape = {
  id: required(of({ provider: required(provider), sourceId: required(text) })),
  name: required(text),
  release: required((value) => value === null || text(value)),
  preparation: required(oneOf("raw", "cooked", "as-sold", "prepared", "unknown")),
  nutrition: required(
    of({
      basis: required(oneOf("per-100-g", "per-100-ml", "per-portion")),
      nutrients: required(nutrients),
      portionSize: optional(of({ amount: required(positive), unit: required(oneOf("g", "ml")) })),
      gramsPerMilliliter: optional(positive),
    }),
  ),
};
const capturedItem: Shape = {
  id: required(id),
  food: required(of(food)),
  portion: required(
    of({ amount: required(positive), unit: required(oneOf("g", "ml", "portion")) }),
  ),
  nutrients: required(nutrients),
};
const recordShape: Readonly<Record<string, Shape>> = {
  meal: {
    id: required(id),
    localDay: required(day),
    occurredAt: required(instant),
    utcOffsetMinutes: optional(utcOffset),
    items: required(items(capturedItem, 0)),
  },
  "custom-food": food,
  recipe: {
    id: required(id),
    name: required(text),
    ingredients: required(items(capturedItem)),
    servings: required(positive),
    cookedWeightG: optional(positive),
  },
  "meal-template": { id: required(id), name: required(text), items: required(items(capturedItem)) },
  favorite: { provider: required(provider), sourceId: required(id), food: optional(of(food)) },
  "weigh-in": {
    id: required(id),
    localDay: required(day),
    occurredAt: required(instant),
    kg: required(positive),
  },
  "nutrition-target": {
    id: required(id),
    effectiveDay: required(day),
    configuredAt: required(instant),
    mode: required(oneOf("manual", "calculated")),
    target: required(
      of({
        kcal: required(positive),
        proteinG: required(nonNegative),
        fatG: required(nonNegative),
        availableCarbohydratesG: required(nonNegative),
      }),
    ),
  },
};

function object(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function invalid(reason: string): never {
  throw new InvalidSyncContent(reason);
}

function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((child, index) => sameJson(child, b[index]));
  }
  const left = object(a);
  const right = object(b);
  if (!left || !right) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  );
}

function apply(
  rule: Rule,
  current: JsonValue | undefined,
  value: JsonValue,
  name: string,
): JsonValue {
  if (typeof rule === "function") {
    if (!rule(value)) return invalid(`Invalid ${name}`);
    return value;
  }
  if ("fields" in rule) {
    const submitted = object(value);
    return submitted
      ? project(rule.fields, object(current), submitted, name)
      : invalid(`Invalid ${name}`);
  }
  if (!Array.isArray(value) || value.length < rule.min) return invalid(`Invalid ${name}`);
  const previous = new Map<string, JsonObject>();
  for (const entry of Array.isArray(current) ? current : []) {
    const row = object(entry);
    if (row && typeof row.id === "string") previous.set(row.id, row);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const row = object(entry);
    if (!row || typeof row.id !== "string" || seen.has(row.id))
      return invalid(`Invalid IDs in ${name}`);
    seen.add(row.id);
    return project(rule.keyedItems, previous.get(row.id) ?? null, row, name);
  });
}

function project(
  shape: Shape,
  current: JsonObject | null,
  submitted: JsonObject,
  name: string,
): JsonObject {
  const next = { ...current };
  for (const [key, value] of Object.entries(submitted)) {
    if (Object.hasOwn(shape, key)) continue;
    // An older peer may echo an opaque value. It can only write fields declared by its release.
    if (!current || !Object.hasOwn(current, key) || !sameJson(current[key], value)) {
      return invalid(`This release cannot set one of the fields in ${name}`);
    }
  }
  for (const [key, { rule, optional }] of Object.entries(shape)) {
    const value = submitted[key];
    if (value !== undefined) {
      next[key] = apply(rule, current?.[key], value, `${name}.${key}`);
    } else if (optional) {
      delete next[key];
    } else {
      return invalid(`Missing ${name}.${key}`);
    }
  }
  return next;
}

function verifyIdentity(key: RecordKey, record: JsonObject) {
  if (key.kind === "favorite") {
    if (JSON.stringify([record.provider, record.sourceId]) !== key.id) {
      return invalid("The favourite content does not match its record ID");
    }
    const snapshot = object(record.food);
    const snapshotId = object(snapshot?.id);
    if (
      snapshot &&
      (!snapshotId ||
        record.provider !== "open-food-facts" ||
        snapshot.release === null ||
        snapshotId.provider !== record.provider ||
        snapshotId.sourceId !== record.sourceId)
    ) {
      return invalid("The saved nutrition does not match its favourite");
    }
    return;
  }
  if (key.kind === "custom-food") {
    const foodId = object(record.id);
    if (
      foodId?.provider !== "local" ||
      foodId.sourceId !== key.id ||
      record.release !== null ||
      key.id.startsWith("recipe:")
    ) {
      return invalid("The custom food content does not match its record ID");
    }
    return;
  }
  if (record.id !== key.id) return invalid("The content does not match its record ID");
  if (key.kind === "nutrition-target") {
    const target = record.target as unknown as DailyNutritionTarget;
    try {
      const expected = manualNutritionTarget(target);
      if (target.availableCarbohydratesG !== expected.availableCarbohydratesG) {
        return invalid("The carbohydrate target must fill the remaining energy budget");
      }
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError)
        return invalid("Invalid nutrition target energy budget");
      throw error;
    }
  }
  if (key.kind === "recipe") {
    try {
      foodForRecipe(record as unknown as Recipe);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError)
        return invalid("Invalid recorded recipe portions");
      throw error;
    }
  }
}

/** Validate candidate content while retaining fields defined by a later writer. */
export function applyRecordContent({
  key,
  release,
  current,
  submitted,
}: {
  key: RecordKey;
  release: string;
  current: JsonObject | null;
  submitted: JsonObject;
}): JsonObject {
  const shape = Object.hasOwn(recordShape, key.kind) ? recordShape[key.kind] : undefined;
  if (release !== syncCandidate.release || !shape) {
    return invalid("Record is unavailable to this sync release");
  }
  const record = project(shape, current, submitted, key.kind);
  verifyIdentity(key, record);
  if (key.kind === "nutrition-target" && current && !sameJson(current, record)) {
    return invalid("Changing a nutrition target requires a new revision ID");
  }
  if (
    key.kind === "meal" &&
    record.utcOffsetMinutes === undefined &&
    current?.utcOffsetMinutes !== undefined &&
    utcOffset(current.utcOffsetMinutes) &&
    record.localDay === current.localDay &&
    record.occurredAt === current.occurredAt
  ) {
    return { ...record, utcOffsetMinutes: current.utcOffsetMinutes };
  }
  return record;
}

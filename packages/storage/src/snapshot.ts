import type { DiaryItem, Food, FoodId, FoodNutrition, Nutrients, Portion } from "@edo/core";

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid diary ${name}`);
  }
  return value as Record<string, unknown>;
}

function diaryText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Invalid diary ${name}`);
  }
  return value;
}

export function diaryId(value: unknown, name: string): string {
  const id = diaryText(value, name);
  // SQLite stores UTF-8. A lone surrogate would be replaced and could alias another record ID.
  if (id.includes("\0") || /[\uD800-\uDFFF]/u.test(id)) {
    throw new TypeError(`Invalid diary ${name}`);
  }
  return id;
}

export function readDay(day: unknown): string {
  if (typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const date = new Date(`${day}T00:00:00.000Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day) return day;
  }
  throw new TypeError("Invalid diary calendar day");
}

export function readInstant(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new TypeError("Invalid diary event time");
  }
  return value;
}

export function readUtcOffset(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) >= 24 * 60) {
    throw new TypeError("Invalid diary UTC offset");
  }
  return value;
}

export function decodeSnapshot(json: unknown): Omit<DiaryItem, "id"> {
  return readSnapshot(JSON.parse(diaryText(json, "item snapshot")));
}

function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`Invalid diary ${name}`);
  }
  return value;
}

function readPortion(input: unknown): Portion {
  const { amount, unit } = object(input, "portion");
  if (unit !== "g" && unit !== "ml" && unit !== "portion") {
    throw new TypeError("Invalid diary portion unit");
  }
  return { amount: positive(amount, "portion amount"), unit };
}

function readNutrients(input: unknown): Nutrients {
  const data = object(input, "nutrients");
  const nutrient = (key: keyof Nutrients): number | null => {
    const value = data[key];
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`Invalid diary nutrient ${key}`);
    }
    return value;
  };
  return {
    kcal: nutrient("kcal"),
    proteinG: nutrient("proteinG"),
    availableCarbohydratesG: nutrient("availableCarbohydratesG"),
    fatG: nutrient("fatG"),
    fiberG: nutrient("fiberG"),
  };
}

function readFoodNutrition(input: unknown): FoodNutrition {
  const { basis, nutrients, portionSize, gramsPerMilliliter } = object(input, "food nutrition");
  if (basis !== "per-100-g" && basis !== "per-100-ml" && basis !== "per-portion") {
    throw new TypeError("Invalid diary nutrition basis");
  }

  const size = portionSize === undefined ? undefined : readPortion(portionSize);
  if (size?.unit === "portion") {
    throw new TypeError("Invalid diary measured portion size");
  }
  return {
    basis,
    nutrients: readNutrients(nutrients),
    ...(size === undefined ? {} : { portionSize: { amount: size.amount, unit: size.unit } }),
    ...(gramsPerMilliliter === undefined
      ? {}
      : { gramsPerMilliliter: positive(gramsPerMilliliter, "density") }),
  };
}

export function readFoodId(input: unknown): FoodId {
  const { provider, sourceId } = object(input, "food ID");
  if (
    provider !== "bls" &&
    provider !== "open-food-facts" &&
    provider !== "usda" &&
    provider !== "local"
  ) {
    throw new TypeError("Invalid diary food provider");
  }
  return { provider, sourceId: diaryText(sourceId, "food source ID") };
}

export function readFood(input: unknown): Food {
  const { id, name, release, preparation, nutrition } = object(input, "food");
  const identity = readFoodId(id);
  if (
    preparation !== "raw" &&
    preparation !== "cooked" &&
    preparation !== "as-sold" &&
    preparation !== "prepared" &&
    preparation !== "unknown"
  ) {
    throw new TypeError("Invalid diary food preparation");
  }
  return {
    id: identity,
    name: diaryText(name, "food name"),
    release: release === null ? null : diaryText(release, "catalog release"),
    preparation,
    nutrition: readFoodNutrition(nutrition),
  };
}

/** Check the stored representation without recalculating a historical nutrient value. */
export function readSnapshot(input: unknown): Omit<DiaryItem, "id"> {
  const { portion, food, nutrients } = object(input, "item snapshot");
  return {
    portion: readPortion(portion),
    food: readFood(food),
    nutrients: readNutrients(nutrients),
  };
}

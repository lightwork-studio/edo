import type { DiaryMeal } from "@edo/core";
import { diaryId, readDay, readInstant, readSnapshot, readUtcOffset } from "./snapshot.ts";

export interface DiaryRestoreIssue {
  readonly mealIndex: number;
  readonly message: string;
}

const format = "edo-diary";
const formatVersion = 1;
const nutrientKeys = ["kcal", "proteinG", "availableCarbohydratesG", "fatG", "fiberG"];
const portionKeys = ["amount", "unit"];

export function archiveRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid diary archive record");
  }
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new TypeError("Unsupported diary archive field");
  }
  return value as Record<string, unknown>;
}

export function checkArchiveFood(input: unknown): void {
  const food = archiveRecord(input, ["id", "name", "release", "preparation", "nutrition"]);
  const nutrition = archiveRecord(food.nutrition, [
    "basis",
    "nutrients",
    "portionSize",
    "gramsPerMilliliter",
  ]);
  archiveRecord(food.id, ["provider", "sourceId"]);
  archiveRecord(nutrition.nutrients, nutrientKeys);
  if (nutrition.portionSize !== undefined) archiveRecord(nutrition.portionSize, portionKeys);
}

export function readArchiveItem(value: unknown) {
  const item = archiveRecord(value, ["id", "portion", "food", "nutrients"]);
  checkArchiveFood(item.food);
  archiveRecord(item.portion, portionKeys);
  archiveRecord(item.nutrients, nutrientKeys);
  return { id: diaryId(item.id, "item ID"), ...readSnapshot(item) };
}

function readMeal(value: unknown): DiaryMeal {
  const data = archiveRecord(value, ["id", "localDay", "occurredAt", "utcOffsetMinutes", "items"]);
  if (!Array.isArray(data.items)) throw new TypeError("Invalid diary archive items");
  const utcOffsetMinutes = readUtcOffset(data.utcOffsetMinutes);
  if ("utcOffsetMinutes" in data && utcOffsetMinutes === undefined) {
    throw new TypeError("Invalid diary archive UTC offset");
  }
  return {
    id: diaryId(data.id, "meal ID"),
    localDay: readDay(data.localDay),
    occurredAt: readInstant(data.occurredAt),
    ...(utcOffsetMinutes === undefined ? {} : { utcOffsetMinutes }),
    items: Array.from(data.items, readArchiveItem),
  };
}

export function readDiaryArchiveValue(value: unknown, onIssue?: () => void) {
  const root = archiveRecord(value, ["format", "formatVersion", "meals"]);
  if (
    root.format !== format ||
    root.formatVersion !== formatVersion ||
    !Array.isArray(root.meals)
  ) {
    throw new TypeError("Unsupported diary archive format");
  }

  return readMealEntries(root.meals, onIssue);
}

export function readMealEntries(meals: readonly unknown[], onIssue?: () => void) {
  const entries: { index: number; meal: DiaryMeal }[] = [];
  const issues: DiaryRestoreIssue[] = [];
  const mealIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const [index, raw] of meals.entries()) {
    try {
      const meal = readMeal(raw);
      const members = new Set(meal.items.map((item) => item.id));
      if (mealIds.has(meal.id)) throw new TypeError("Duplicate meal ID in the archive");
      if (members.size !== meal.items.length || meal.items.some((item) => itemIds.has(item.id))) {
        throw new TypeError("Duplicate item ID in the archive");
      }
      mealIds.add(meal.id);
      for (const id of members) itemIds.add(id);
      entries.push({ index, meal });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      onIssue?.();
      issues.push({ mealIndex: index, message: error.message });
    }
  }
  return { entries, issues };
}

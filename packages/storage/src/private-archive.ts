import type { DiaryMeal, FoodId } from "@edo/core";
import {
  archiveRecord,
  checkArchiveFood,
  readArchiveItem,
  readDiaryArchiveValue,
  readMealEntries,
} from "./diary-archive.ts";
import {
  insertDiaryProgressRecords,
  type NutritionTargetRecord,
  readDiaryProgressRecords,
  readNutritionTarget,
  readWeighIn,
  validateTargetBudget,
} from "./diary-progress.ts";
import {
  insertMyFoodsRecords,
  readCustomFood,
  readFavoriteId,
  readMyFoodsRecords,
  readRecipe,
  readTemplate,
} from "./my-foods.ts";
import type { DiarySqliteConnection } from "./sqlite.ts";

const format = "edo-diary";
const formatVersion = 2;
const additionalCollections = [
  "customFoods",
  "recipes",
  "mealTemplates",
  "favorites",
  "weighIns",
  "nutritionTargets",
] as const;

type AdditionalRecords = ReturnType<typeof readMyFoodsRecords> &
  ReturnType<typeof readDiaryProgressRecords>;
type Collection = (typeof additionalCollections)[number];

type Indexed<T> = { readonly index: number; readonly record: T };
type IndexedRecords = { readonly [K in Collection]: Indexed<AdditionalRecords[K][number]>[] };

export interface PrivateArchiveIssue {
  readonly collection: "meals" | Collection;
  readonly index: number;
  readonly message: string;
}

export interface PrivateArchivePreview {
  readonly newRecords: number;
  readonly alreadyPresent: number;
  readonly issues: readonly PrivateArchiveIssue[];
}

export type PrivateArchiveResult =
  | { readonly status: "restored"; readonly added: number; readonly alreadyPresent: number }
  | { readonly status: "rejected"; readonly preview: PrivateArchivePreview };

function readArchiveRecipe(input: unknown) {
  const value = archiveRecord(input, ["id", "name", "ingredients", "servings", "cookedWeightG"]);
  return readRecipe({ ...value, ingredients: readArchiveItems(value.ingredients) });
}

function readArchiveTemplate(input: unknown) {
  const value = archiveRecord(input, ["id", "name", "items"]);
  return readTemplate({ ...value, items: readArchiveItems(value.items) });
}

function readArchiveItems(value: unknown) {
  if (!Array.isArray(value)) throw new TypeError("Invalid saved food archive items");
  return Array.from(value, readArchiveItem);
}

export function readArchiveWeighIn(input: unknown) {
  const value = archiveRecord(input, ["id", "localDay", "occurredAt", "kg"]);
  return readWeighIn({
    id: value.id,
    local_day: value.localDay,
    occurred_at: value.occurredAt,
    kg: value.kg,
  });
}

function readArchiveTarget(input: unknown) {
  const value = archiveRecord(input, ["id", "effectiveDay", "configuredAt", "mode", "target"]);
  const target = archiveRecord(value.target, [
    "kcal",
    "proteinG",
    "fatG",
    "availableCarbohydratesG",
  ]);
  const record = readNutritionTarget({
    id: value.id,
    effective_day: value.effectiveDay,
    configured_at: value.configuredAt,
    mode: value.mode,
    kcal: target.kcal,
    protein_g: target.proteinG,
    fat_g: target.fatG,
    carbohydrate_g: target.availableCarbohydratesG,
  });
  validateTargetBudget(record.target);
  return record;
}

function favoriteKey(id: FoodId): string {
  return JSON.stringify([id.provider, id.sourceId]);
}

function archiveArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Invalid diary archive collection");
  return value;
}

function readCollection<T>(
  root: Record<string, unknown>,
  collection: Collection,
  read: (input: unknown) => T,
  idOf: (record: T) => string,
  issues: PrivateArchiveIssue[],
): Indexed<T>[] {
  const rows = archiveArray(root[collection]);
  const ids = new Set<string>();
  const records: Indexed<T>[] = [];
  for (const [index, row] of rows.entries()) {
    try {
      const record = read(row);
      const id = idOf(record);
      if (ids.has(id)) throw new TypeError("Duplicate ID in this archive collection");
      ids.add(id);
      records.push({ index, record });
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
      issues.push({ collection, index, message: error.message });
    }
  }
  return records;
}

export function readPrivateArchive(source: string): {
  meals: ReturnType<typeof readMealEntries>;
  records: IndexedRecords | null;
  issues: PrivateArchiveIssue[];
} {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError("Invalid diary archive JSON");
    throw error;
  }
  const root = archiveRecord(value, ["format", "formatVersion", "meals", ...additionalCollections]);
  if (root.format === format && root.formatVersion === 1) {
    return { meals: readDiaryArchiveValue(value), records: null, issues: [] };
  }
  if (root.format !== format || root.formatVersion !== formatVersion) {
    throw new TypeError("Unsupported diary archive format");
  }
  const issues: PrivateArchiveIssue[] = [];
  const meals = readMealEntries(archiveArray(root.meals));
  const records = {
    customFoods: readCollection(
      root,
      "customFoods",
      (row) => {
        checkArchiveFood(row);
        return readCustomFood(row);
      },
      (record) => record.id.sourceId,
      issues,
    ),
    recipes: readCollection(root, "recipes", readArchiveRecipe, (record) => record.id, issues),
    mealTemplates: readCollection(
      root,
      "mealTemplates",
      readArchiveTemplate,
      (record) => record.id,
      issues,
    ),
    favorites: readCollection(
      root,
      "favorites",
      (row) => readFavoriteId(archiveRecord(row, ["provider", "sourceId"])),
      favoriteKey,
      issues,
    ),
    weighIns: readCollection(root, "weighIns", readArchiveWeighIn, (record) => record.id, issues),
    nutritionTargets: readCollection(
      root,
      "nutritionTargets",
      readArchiveTarget,
      (record) => record.id,
      issues,
    ),
  };
  return { meals, records, issues };
}

export function createPrivateArchive(
  db: DiarySqliteConnection,
  meals: readonly DiaryMeal[],
): string {
  const records = {
    format,
    formatVersion,
    meals,
    ...readMyFoodsRecords(db),
    ...readDiaryProgressRecords(db),
  };
  return `${JSON.stringify(records, null, 2)}\n`;
}

function byDay<T>(records: readonly T[], dayOf: (record: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const day = dayOf(record);
    const matches = grouped.get(day);
    if (matches) matches.push(record);
    else grouped.set(day, [record]);
  }
  return grouped;
}

function targetOrderConflicts(
  archived: Indexed<NutritionTargetRecord>[],
  existing: NutritionTargetRecord[],
  add: NutritionTargetRecord[],
  issues: PrivateArchiveIssue[],
): Set<string> {
  const bySavedDay = byDay(existing, ({ effectiveDay }) => effectiveDay);
  const byArchiveDay = byDay(archived, ({ record }) => record.effectiveDay);
  const daysWithAdditions = new Set(add.map(({ effectiveDay }) => effectiveDay));
  const conflicts = new Set<string>();
  for (const [day, incoming] of byArchiveDay) {
    const saved = (bySavedDay.get(day) ?? []).map(({ id }) => id);
    const archivedIds = incoming.map(({ record }) => record.id);
    const archivedSet = new Set(archivedIds);
    const savedSet = new Set(saved);
    const adding = daysWithAdditions.has(day);
    // New records append to the database. On an overlapping day, the stored history must
    // already be the archive's prefix or its relative order could change.
    const currentOrder = adding ? saved : saved.filter((id) => archivedSet.has(id));
    const archiveOrder = adding ? archivedIds : archivedIds.filter((id) => savedSet.has(id));
    const mismatch = currentOrder.findIndex((id, index) => id !== archiveOrder[index]);
    if (mismatch >= 0) {
      const entry =
        incoming.find(({ record }) => record.id === archiveOrder[mismatch]) ?? incoming[0];
      if (entry)
        issues.push({
          collection: "nutritionTargets",
          index: entry.index,
          message: "The saved targets have a different order on this day",
        });
      conflicts.add(day);
    }
  }
  return conflicts;
}

export function planPrivateRecords(
  db: DiarySqliteConnection,
  archived: IndexedRecords,
  issues: PrivateArchiveIssue[],
) {
  const current = { ...readMyFoodsRecords(db), ...readDiaryProgressRecords(db) };
  let alreadyPresent = 0;
  function compare<T>(
    collection: Collection,
    incoming: Indexed<T>[],
    existing: T[],
    idOf: (record: T) => string,
  ): T[] {
    const byId = new Map(existing.map((record) => [idOf(record), record]));
    const additions: T[] = [];
    for (const { index, record } of incoming) {
      const saved = byId.get(idOf(record));
      if (saved === undefined) additions.push(record);
      else if (JSON.stringify(saved) === JSON.stringify(record)) alreadyPresent += 1;
      else issues.push({ collection, index, message: "This ID has different saved content" });
    }
    return additions;
  }
  const targets = compare(
    "nutritionTargets",
    archived.nutritionTargets,
    current.nutritionTargets,
    (record) => record.id,
  );
  const blockedDays = targetOrderConflicts(
    archived.nutritionTargets,
    current.nutritionTargets,
    targets,
    issues,
  );
  const additions = {
    customFoods: compare(
      "customFoods",
      archived.customFoods,
      current.customFoods,
      (record) => record.id.sourceId,
    ),
    recipes: compare("recipes", archived.recipes, current.recipes, (record) => record.id),
    mealTemplates: compare(
      "mealTemplates",
      archived.mealTemplates,
      current.mealTemplates,
      (record) => record.id,
    ),
    favorites: compare("favorites", archived.favorites, current.favorites, favoriteKey),
    weighIns: compare("weighIns", archived.weighIns, current.weighIns, (record) => record.id),
    nutritionTargets: targets.filter(({ effectiveDay }) => !blockedDays.has(effectiveDay)),
  };
  const newRecords = additionalCollections.reduce(
    (total, collection) => total + additions[collection].length,
    0,
  );
  return { additions, newRecords, alreadyPresent };
}

export function insertPrivateRecords(db: DiarySqliteConnection, records: AdditionalRecords): void {
  insertMyFoodsRecords(db, records);
  insertDiaryProgressRecords(db, records);
}

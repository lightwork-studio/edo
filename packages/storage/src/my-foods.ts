import {
  type DiaryItem,
  type DiaryMeal,
  type Food,
  type FoodId,
  foodForRecipe,
  type Recipe,
} from "@edo/core";
import { inCurrentDiary } from "./migrations.ts";
import {
  diaryId,
  readDay,
  readFood,
  readFoodId,
  readInstant,
  readSnapshot,
  readUtcOffset,
} from "./snapshot.ts";
import type { DiarySqliteConnection, SqlRow } from "./sqlite.ts";

export interface SavedMealTemplate {
  readonly id: string;
  readonly name: string;
  readonly items: readonly DiaryItem[];
}

export interface MyFoodsStore {
  saveCustomFood(food: Food): void;
  listCustomFoods(): Food[];
  deleteCustomFood(sourceId: string): void;
  saveRecipe(recipe: Recipe): void;
  listRecipes(): Recipe[];
  saveMealTemplate(template: SavedMealTemplate): void;
  listMealTemplates(): SavedMealTemplate[];
  setFavorite(id: FoodId, enabled: boolean): void;
  listFavorites(): FoodId[];
}

type Table = "diary_custom_foods" | "diary_recipes" | "diary_meal_templates";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid saved food record");
  }
  return value as Record<string, unknown>;
}

function readName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("A saved food needs a name");
  return value;
}

function readItems(value: unknown): DiaryItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("A saved food or meal needs at least one item");
  }
  const items = Array.from(value, (item: unknown) => ({
    id: diaryId(record(item).id, "item ID"),
    ...readSnapshot(item),
  }));
  if (new Set(items.map(({ id }) => id)).size !== items.length) {
    throw new TypeError("Saved food item IDs must be unique");
  }
  return items;
}

function customSourceId(value: unknown): string {
  const id = diaryId(value, "custom food ID");
  if (id.startsWith("recipe:")) throw new TypeError("Custom food IDs cannot use a recipe ID");
  return id;
}

export function readCustomFood(value: unknown): Food {
  const food = readFood(value);
  if (food.id.provider !== "local" || food.release !== null) {
    throw new TypeError("Custom foods need a local ID and no catalog release");
  }
  customSourceId(food.id.sourceId);
  return food;
}

export function readRecipe(value: unknown): Recipe {
  const { id, name, ingredients, servings, cookedWeightG } = record(value);
  if (
    typeof servings !== "number" ||
    (cookedWeightG !== undefined && typeof cookedWeightG !== "number")
  ) {
    throw new TypeError("Invalid saved recipe's servings or weight");
  }
  const recipe = {
    id: diaryId(id, "recipe ID"),
    name: readName(name),
    ingredients: readItems(ingredients),
    servings,
    ...(cookedWeightG !== undefined && { cookedWeightG }),
  };
  foodForRecipe(recipe);
  return recipe;
}

export function readTemplate(value: unknown): SavedMealTemplate {
  const { id, name, items } = record(value);
  return { id: diaryId(id, "meal template ID"), name: readName(name), items: readItems(items) };
}

export function readFavoriteId(value: unknown): FoodId {
  const id = readFoodId(value);
  diaryId(id.sourceId, "favorite source ID");
  return id;
}

function readCollection<T>(
  db: DiarySqliteConnection,
  table: Table,
  read: (value: unknown) => T,
  idOf: (record: T) => string,
): T[] {
  return db.all(`SELECT id, content FROM ${table} ORDER BY id`).map((row) => {
    if (typeof row.content !== "string") throw new TypeError("Invalid saved food content");
    const saved = read(JSON.parse(row.content));
    if (idOf(saved) !== row.id) throw new Error("Saved food ID does not match its record");
    return saved;
  });
}

function writeRecord(
  db: DiarySqliteConnection,
  table: Table,
  id: string,
  value: unknown,
  replace: boolean,
) {
  const insert = `INSERT INTO ${table} (id, content) VALUES (?, ?)`;
  const operation = replace
    ? `${insert} ON CONFLICT(id) DO UPDATE SET content = excluded.content`
    : insert;
  db.run(operation, id, JSON.stringify(value));
}

function saveRecord(db: DiarySqliteConnection, table: Table, id: string, value: unknown) {
  inCurrentDiary(db, "BEGIN IMMEDIATE", () => writeRecord(db, table, id, value, true));
}

function customFoods(db: DiarySqliteConnection) {
  return readCollection(db, "diary_custom_foods", readCustomFood, (food) => food.id.sourceId);
}

function recipes(db: DiarySqliteConnection) {
  return readCollection(db, "diary_recipes", readRecipe, (recipe) => recipe.id);
}

function templates(db: DiarySqliteConnection) {
  return readCollection(db, "diary_meal_templates", readTemplate, (template) => template.id);
}

function favorites(db: DiarySqliteConnection) {
  return db
    .all("SELECT provider, source_id FROM diary_favorites ORDER BY provider, source_id")
    .map((row: SqlRow) => readFavoriteId({ provider: row.provider, sourceId: row.source_id }));
}

export function readMyFoodsRecords(db: DiarySqliteConnection) {
  return {
    customFoods: customFoods(db),
    recipes: recipes(db),
    mealTemplates: templates(db),
    favorites: favorites(db),
  };
}

export function verifyMyFoods(db: DiarySqliteConnection) {
  readMyFoodsRecords(db);
}

/** The archive has already validated these records and owns the surrounding transaction. */
export function insertMyFoodsRecords(
  db: DiarySqliteConnection,
  records: ReturnType<typeof readMyFoodsRecords>,
) {
  for (const food of records.customFoods)
    writeRecord(db, "diary_custom_foods", food.id.sourceId, food, false);
  for (const recipe of records.recipes) writeRecord(db, "diary_recipes", recipe.id, recipe, false);
  for (const meal of records.mealTemplates)
    writeRecord(db, "diary_meal_templates", meal.id, meal, false);
  for (const { provider, sourceId } of records.favorites)
    db.run("INSERT INTO diary_favorites VALUES (?, ?)", provider, sourceId);
}

export function myFoods(db: DiarySqliteConnection): MyFoodsStore {
  return {
    saveCustomFood(value) {
      const food = readCustomFood(value);
      saveRecord(db, "diary_custom_foods", food.id.sourceId, food);
    },
    listCustomFoods: () => inCurrentDiary(db, "BEGIN", () => customFoods(db)),
    deleteCustomFood(value) {
      const id = customSourceId(value);
      inCurrentDiary(db, "BEGIN IMMEDIATE", () => {
        db.run("DELETE FROM diary_custom_foods WHERE id = ?", id);
        db.run("DELETE FROM diary_favorites WHERE provider = 'local' AND source_id = ?", id);
      });
    },
    saveRecipe(value) {
      const recipe = readRecipe(value);
      saveRecord(db, "diary_recipes", recipe.id, recipe);
    },
    listRecipes: () => inCurrentDiary(db, "BEGIN", () => recipes(db)),
    saveMealTemplate(value) {
      const template = readTemplate(value);
      saveRecord(db, "diary_meal_templates", template.id, template);
    },
    listMealTemplates: () => inCurrentDiary(db, "BEGIN", () => templates(db)),
    setFavorite(value, enabled) {
      const { provider, sourceId } = readFavoriteId(value);
      inCurrentDiary(db, "BEGIN IMMEDIATE", () => {
        if (enabled) {
          db.run(
            "INSERT INTO diary_favorites VALUES (?, ?) ON CONFLICT(provider, source_id) DO NOTHING",
            provider,
            sourceId,
          );
        } else {
          db.run(
            "DELETE FROM diary_favorites WHERE provider = ? AND source_id = ?",
            provider,
            sourceId,
          );
        }
      });
    },
    listFavorites: () => inCurrentDiary(db, "BEGIN", () => favorites(db)),
  };
}

/** Repeat the captured portions and nutrition with fresh diary identities. */
export function mealFromTemplate(
  template: SavedMealTemplate,
  entry: Omit<DiaryMeal, "items">,
  newItemId: () => string,
): DiaryMeal {
  const captured = readTemplate(template);
  const originalIds = new Set(captured.items.map(({ id }) => id));
  const items = captured.items.map((item) => {
    const id = diaryId(newItemId(), "item ID");
    if (originalIds.has(id)) throw new TypeError("Repeated meals need fresh item IDs");
    return { ...item, id };
  });
  if (new Set(items.map(({ id }) => id)).size !== items.length) {
    throw new TypeError("Repeated meal item IDs must be unique");
  }
  const utcOffsetMinutes = readUtcOffset(entry.utcOffsetMinutes);
  return {
    id: diaryId(entry.id, "meal ID"),
    localDay: readDay(entry.localDay),
    occurredAt: readInstant(entry.occurredAt),
    ...(utcOffsetMinutes === undefined ? {} : { utcOffsetMinutes }),
    items,
  };
}

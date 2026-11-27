import type { DiaryItem, DiaryMeal } from "@edo/core";
import { type DiaryProgressStore, diaryProgress, verifyDiaryProgress } from "./diary-progress.ts";
import { type DiaryBackup, diaryMigrations, inCurrentDiary, migrateDiary } from "./migrations.ts";
import { decodeSnapshot, diaryId, readDay, readInstant, readSnapshot } from "./snapshot.ts";
import type { DiarySqliteConnection, SqlRow } from "./sqlite.ts";

export type { DiaryMeal } from "@edo/core";

export interface DiaryStore {
  saveMeal(meal: DiaryMeal): void;
  deleteMeal(id: string): void;
  getMeal(id: string): DiaryMeal | null;
  listMeals(localDay: string): DiaryMeal[];
  latestMealDay(): string | null;
}

export interface OpenDiaryOptions {
  readonly connection: DiarySqliteConnection;
  /** Copy the diary through a separate connection and pass the preserved snapshot to verification. */
  readonly backupBeforeMigration: DiaryBackup;
}

function readUtcOffset(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) >= 24 * 60) {
    throw new TypeError("Invalid diary UTC offset");
  }
  return value;
}

const selectMeals = `
  SELECT meals.id AS meal_id, meals.local_day, meals.occurred_at, meals.utc_offset_minutes,
    items.id AS item_id, items.snapshot
  FROM diary_meals AS meals
  LEFT JOIN diary_items AS items ON meals.id = items.meal_id
`;

function readMeals(rows: SqlRow[]): DiaryMeal[] {
  type AssemblingMeal = Omit<DiaryMeal, "items"> & { items: DiaryItem[] };
  const meals = new Map<string, AssemblingMeal>();
  for (const row of rows) {
    const id = diaryId(row.meal_id, "meal ID");
    let meal = meals.get(id);
    if (meal === undefined) {
      const utcOffsetMinutes = readUtcOffset(row.utc_offset_minutes);
      meal = {
        id,
        localDay: readDay(row.local_day),
        occurredAt: readInstant(row.occurred_at),
        ...(utcOffsetMinutes === undefined ? {} : { utcOffsetMinutes }),
        items: [],
      };
      meals.set(id, meal);
    }
    if (row.item_id !== null) {
      const itemId = diaryId(row.item_id, "item ID");
      const snapshot = decodeSnapshot(row.snapshot);
      meal.items.push({ id: itemId, ...snapshot });
    }
  }
  return [...meals.values()];
}

function saveMeal(db: DiarySqliteConnection, meal: DiaryMeal): void {
  const id = diaryId(meal.id, "meal ID");
  const localDay = readDay(meal.localDay);
  const occurredAt = readInstant(meal.occurredAt);
  const utcOffsetMinutes = readUtcOffset(meal.utcOffsetMinutes) ?? null;
  const items = meal.items.map((item) => ({
    id: diaryId(item.id, "item ID"),
    snapshot: JSON.stringify(readSnapshot(item)),
  }));

  inCurrentDiary(db, "BEGIN IMMEDIATE", () => {
    db.run(
      `INSERT INTO diary_meals (id, local_day, occurred_at, utc_offset_minutes) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        local_day = excluded.local_day,
        occurred_at = excluded.occurred_at,
        utc_offset_minutes = CASE
          WHEN excluded.local_day = diary_meals.local_day
            AND excluded.occurred_at = diary_meals.occurred_at
          THEN coalesce(excluded.utc_offset_minutes, diary_meals.utc_offset_minutes)
          ELSE excluded.utc_offset_minutes
        END`,
      id,
      localDay,
      occurredAt,
      utcOffsetMinutes,
    );
    db.run("DELETE FROM diary_items WHERE meal_id = ?", id);
    for (const [position, item] of items.entries()) {
      db.run(
        "INSERT INTO diary_items (id, meal_id, position, snapshot) VALUES (?, ?, ?, ?)",
        item.id,
        id,
        position,
        item.snapshot,
      );
    }
  });
}

/** Open the private diary on a connection owned by the caller. */
export async function openDiary({
  connection: db,
  backupBeforeMigration,
}: OpenDiaryOptions): Promise<DiaryStore & DiaryProgressStore> {
  await migrateDiary(db, diaryMigrations, backupBeforeMigration, (connection) => {
    readMeals(connection.all(selectMeals));
    verifyDiaryProgress(connection);
  });
  return {
    ...diaryProgress(db),
    saveMeal: (meal) => saveMeal(db, meal),
    deleteMeal: (id) =>
      inCurrentDiary(db, "BEGIN IMMEDIATE", () => {
        db.run("DELETE FROM diary_meals WHERE id = ?", diaryId(id, "meal ID"));
      }),
    getMeal: (id) =>
      inCurrentDiary(
        db,
        "BEGIN",
        () =>
          readMeals(
            db.all(
              `${selectMeals} WHERE meals.id = ? ORDER BY items.position`,
              diaryId(id, "meal ID"),
            ),
          )[0] ?? null,
      ),
    listMeals: (localDay) =>
      inCurrentDiary(db, "BEGIN", () =>
        readMeals(
          db.all(
            `${selectMeals} WHERE meals.local_day = ?
            ORDER BY meals.occurred_at, meals.id, items.position`,
            readDay(localDay),
          ),
        ),
      ),
    latestMealDay: () =>
      inCurrentDiary(db, "BEGIN", () => {
        const row = db.get("SELECT local_day FROM diary_meals ORDER BY local_day DESC LIMIT 1");
        return row ? readDay(row.local_day) : null;
      }),
  };
}

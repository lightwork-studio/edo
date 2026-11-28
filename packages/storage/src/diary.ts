import type { DiaryItem, DiaryMeal } from "@edo/core";
import { openSyncJournal } from "@edo/sync";
import { type DiaryProgressStore, diaryProgress, verifyDiaryProgress } from "./diary-progress.ts";
import {
  type DiaryBackup,
  diaryMigrations,
  inCurrentDiary,
  migrateDiary,
  requireCurrentDiaryVersion,
} from "./migrations.ts";
import { type MyFoodsStore, myFoods, verifyMyFoods } from "./my-foods.ts";
import {
  createPrivateArchive,
  insertPrivateRecords,
  type PrivateArchiveIssue,
  type PrivateArchivePreview,
  type PrivateArchiveResult,
  planPrivateRecords,
  readPrivateArchive,
} from "./private-archive.ts";
import {
  decodeSnapshot,
  diaryId,
  readDay,
  readInstant,
  readSnapshot,
  readUtcOffset,
} from "./snapshot.ts";
import type { DiarySqliteConnection, SqlRow } from "./sqlite.ts";

export type { DiaryMeal } from "@edo/core";

export interface DiaryStore {
  saveMeal(meal: DiaryMeal): void;
  deleteMeal(id: string): void;
  getMeal(id: string): DiaryMeal | null;
  listMeals(localDay: string): DiaryMeal[];
  latestMealDay(): string | null;
}

export interface PrivateArchiveStore {
  exportPrivateArchive(): string;
  previewPrivateArchive(source: string): PrivateArchivePreview;
  restorePrivateArchive(source: string): PrivateArchiveResult;
}

export interface SyncMealStore {
  readonly sync: {
    readonly journal: ReturnType<typeof openSyncJournal>;
    saveMeal(meal: DiaryMeal, submissionId: string): void;
    deleteMeal(id: string, submissionId: string): void;
  };
}

export interface OpenDiaryOptions {
  readonly connection: DiarySqliteConnection;
  /** Copy the diary through a separate connection and pass the preserved snapshot to verification. */
  readonly backupBeforeMigration: DiaryBackup;
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

function prepareMeal(meal: DiaryMeal) {
  return {
    id: diaryId(meal.id, "meal ID"),
    localDay: readDay(meal.localDay),
    occurredAt: readInstant(meal.occurredAt),
    utcOffsetMinutes: readUtcOffset(meal.utcOffsetMinutes) ?? null,
    items: Array.from(meal.items, (item) => ({
      id: diaryId(item.id, "item ID"),
      snapshot: JSON.stringify(readSnapshot(item)),
    })),
  };
}

function writeMeal(
  db: DiarySqliteConnection,
  meal: ReturnType<typeof prepareMeal>,
  update: boolean,
): void {
  const insert =
    "INSERT INTO diary_meals (id, local_day, occurred_at, utc_offset_minutes) VALUES (?, ?, ?, ?)";
  const write = update
    ? `${insert} ON CONFLICT(id) DO UPDATE SET
        local_day = excluded.local_day,
        occurred_at = excluded.occurred_at,
        utc_offset_minutes = CASE
          WHEN excluded.local_day = diary_meals.local_day
            AND excluded.occurred_at = diary_meals.occurred_at
          THEN coalesce(excluded.utc_offset_minutes, diary_meals.utc_offset_minutes)
          ELSE excluded.utc_offset_minutes
        END`
    : insert;
  db.run(write, meal.id, meal.localDay, meal.occurredAt, meal.utcOffsetMinutes);
  if (update) db.run("DELETE FROM diary_items WHERE meal_id = ?", meal.id);
  for (const [position, item] of meal.items.entries()) {
    db.run(
      "INSERT INTO diary_items (id, meal_id, position, snapshot) VALUES (?, ?, ?, ?)",
      item.id,
      meal.id,
      position,
      item.snapshot,
    );
  }
}

function readMeal(db: DiarySqliteConnection, id: string): DiaryMeal | null {
  return (
    readMeals(db.all(`${selectMeals} WHERE meals.id = ? ORDER BY items.position`, id))[0] ?? null
  );
}

function planPrivateRestore(
  db: DiarySqliteConnection,
  archive: ReturnType<typeof readPrivateArchive>,
) {
  const issues: PrivateArchiveIssue[] = [
    ...archive.issues,
    ...archive.meals.issues.map(({ mealIndex, message }) => ({
      collection: "meals" as const,
      index: mealIndex,
      message,
    })),
  ];
  const meals: DiaryMeal[] = [];
  let alreadyPresent = 0;
  for (const { index, meal } of archive.meals.entries) {
    const previous = readMeal(db, meal.id);
    if (previous) {
      if (JSON.stringify(previous) === JSON.stringify(meal)) alreadyPresent += 1;
      else
        issues.push({
          collection: "meals",
          index,
          message: "This meal ID has different saved content",
        });
    } else if (
      meal.items.some((item) => db.get("SELECT id FROM diary_items WHERE id = ?", item.id))
    ) {
      issues.push({
        collection: "meals",
        index,
        message: "An item ID is already used by another saved meal",
      });
    } else {
      meals.push(meal);
    }
  }
  const records = archive.records ? planPrivateRecords(db, archive.records, issues) : null;
  return {
    meals,
    records: records?.additions,
    preview: {
      newRecords: meals.length + (records?.newRecords ?? 0),
      alreadyPresent: alreadyPresent + (records?.alreadyPresent ?? 0),
      issues,
    },
  };
}

/** Open the private diary on a connection owned by the caller. */
export async function openDiary({
  connection: db,
  backupBeforeMigration,
}: OpenDiaryOptions): Promise<
  DiaryStore & DiaryProgressStore & MyFoodsStore & PrivateArchiveStore & SyncMealStore
> {
  await migrateDiary(db, diaryMigrations, backupBeforeMigration, (connection) => {
    readMeals(connection.all(selectMeals));
    verifyDiaryProgress(connection);
    verifyMyFoods(connection);
  });
  const journal = openSyncJournal(db, () => requireCurrentDiaryVersion(db));
  return {
    ...diaryProgress(db),
    ...myFoods(db),
    saveMeal: (meal) => {
      const prepared = prepareMeal(meal);
      inCurrentDiary(db, "BEGIN IMMEDIATE", () => writeMeal(db, prepared, true));
    },
    deleteMeal: (id) =>
      inCurrentDiary(db, "BEGIN IMMEDIATE", () => {
        db.run("DELETE FROM diary_meals WHERE id = ?", diaryId(id, "meal ID"));
      }),
    sync: {
      journal,
      saveMeal: (meal, submissionId) => {
        const prepared = prepareMeal(meal);
        journal.commitLocalProjection({ kind: "meal", id: prepared.id }, submissionId, () => {
          writeMeal(db, prepared, true);
          const persisted = readMeal(db, prepared.id);
          if (!persisted) throw new Error("Could not read the saved meal for sync");
          return { op: "put", content: persisted };
        });
      },
      deleteMeal: (id, submissionId) => {
        const mealId = diaryId(id, "meal ID");
        journal.commitLocalProjection({ kind: "meal", id: mealId }, submissionId, () => {
          db.run("DELETE FROM diary_meals WHERE id = ?", mealId);
          return { op: "delete" };
        });
      },
    },
    getMeal: (id) => inCurrentDiary(db, "BEGIN", () => readMeal(db, diaryId(id, "meal ID"))),
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
    exportPrivateArchive: () =>
      inCurrentDiary(db, "BEGIN", () => {
        const meals = readMeals(
          db.all(`${selectMeals}
          ORDER BY meals.local_day, meals.occurred_at, meals.id, items.position`),
        );
        const source = createPrivateArchive(db, meals);
        const checked = readPrivateArchive(source);
        if (checked.issues.length || checked.meals.issues.length) {
          throw new Error("The private archive could not preserve every diary record");
        }
        return source;
      }),
    previewPrivateArchive: (source) => {
      const archive = readPrivateArchive(source);
      return inCurrentDiary(db, "BEGIN", () => planPrivateRestore(db, archive).preview);
    },
    restorePrivateArchive: (source) => {
      const archive = readPrivateArchive(source);
      return inCurrentDiary(db, "BEGIN IMMEDIATE", () => {
        const { meals, records, preview } = planPrivateRestore(db, archive);
        if (preview.issues.length > 0) return { status: "rejected", preview };
        for (const meal of meals) writeMeal(db, prepareMeal(meal), false);
        if (records) insertPrivateRecords(db, records);
        return {
          status: "restored",
          added: preview.newRecords,
          alreadyPresent: preview.alreadyPresent,
        };
      });
    },
  };
}

import type { Change, NegotiatedSync, PullResponse, PushResponse } from "@edo/contract";
import { type DiaryItem, type DiaryMeal, reconcileDiaryMeal, type WeighIn } from "@edo/core";
import { type MealProjectionHistory, openSyncJournal, type StagedMealChange } from "@edo/sync";
import { readMealEntries } from "./diary-archive.ts";
import {
  type DiaryProgressStore,
  diaryProgress,
  prepareWeighIn,
  readWeighIn,
  verifyDiaryProgress,
  writeWeighIn,
} from "./diary-progress.ts";
import { groupMealProjections, type MealProjectionCandidate } from "./meal-projection-groups.ts";
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
    tryRebaseMeal(session: NegotiatedSync, id: string, submissionId: string): boolean;
    applyMealPage(session: NegotiatedSync, cursor: number, page: PullResponse): MealPullProgress;
    applyMealResults(session: NegotiatedSync, results: PushResponse): MealPullProgress;
    replayMealProjections(session: NegotiatedSync): MealPullProgress;
  };
}

interface MealPullProgress {
  readonly awaitingPages: boolean;
  readonly deferred: readonly string[];
}

export interface SyncDiaryStore extends SyncMealStore {
  readonly sync: SyncMealStore["sync"] & {
    saveWeighIn(entry: WeighIn, submissionId: string): void;
    deleteWeighIn(id: string, submissionId: string): void;
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

function readRebaseMeal(content: unknown, id: string): DiaryMeal | null {
  // Archive decoding rejects opaque fields at every level. Keep those edits for manual review.
  const meal = readMealEntries([content]).entries[0]?.meal;
  return meal?.id === id ? meal : null;
}

function opaqueMealItemIds(change: Change): string[] | undefined {
  if (change.state !== "live" || !Array.isArray(change.content.items)) return undefined;
  const ids = new Set<string>();
  for (const item of change.content.items) {
    if (!item || typeof item !== "object" || !("id" in item)) return undefined;
    try {
      ids.add(diaryId(item.id, "meal item ID"));
    } catch {
      return undefined;
    }
  }
  return [...ids];
}

function projectMeals(
  db: DiarySqliteConnection,
  changes: readonly StagedMealChange[],
  history: (id: string) => MealProjectionHistory,
): string[] {
  const candidates: MealProjectionCandidate[] = [];
  const owners = new Map<string, string>();
  for (const { change, blocked } of changes) {
    const parsed = change.state === "live" ? readRebaseMeal(change.content, change.id) : null;
    const incoming = change.state === "deleted" ? null : (parsed ?? undefined);
    const opaqueClaims = incoming === undefined ? opaqueMealItemIds(change) : undefined;
    const current = readMeal(db, change.id);
    // The existing writer would keep a known offset for an unchanged event. Keep this
    // unsynchronized until a projection can remember the exact effective local value.
    const wouldKeepOffset = Boolean(
      current &&
        incoming &&
        current.utcOffsetMinutes !== undefined &&
        incoming.utcOffsetMinutes === undefined &&
        current.localDay === incoming.localDay &&
        current.occurredAt === incoming.occurredAt,
    );
    const { projection, hadPriorBase } = history(change.id);
    const prior = projection
      ? projection.content === null
        ? null
        : (readRebaseMeal(projection.content, change.id) ?? undefined)
      : undefined;
    candidates.push({
      id: change.id,
      current,
      prior,
      incoming,
      hadPriorBase,
      blocked: blocked || wouldKeepOffset,
      ...(opaqueClaims && { opaqueClaims }),
    });
    const itemIds =
      incoming === undefined ? (opaqueClaims ?? []) : (incoming?.items.map(({ id }) => id) ?? []);
    for (const itemId of itemIds) {
      const row = db.get("SELECT meal_id FROM diary_items WHERE id = ?", itemId);
      if (row) owners.set(itemId, diaryId(row.meal_id, "meal ID"));
    }
  }
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const { groups } = groupMealProjections(candidates, owners);
  for (const group of groups) {
    const replacements = group.flatMap((id) => {
      const candidate = byId.get(id);
      if (!candidate || candidate.incoming === undefined) {
        throw new Error("Missing meal projection candidate");
      }
      return JSON.stringify(candidate.current) === JSON.stringify(candidate.incoming)
        ? []
        : [{ id, incoming: candidate.incoming }];
    });
    // Release all affected owners first so a swap never violates the global item IDs.
    for (const { id } of replacements) db.run("DELETE FROM diary_items WHERE meal_id = ?", id);
    for (const { id, incoming } of replacements) {
      if (incoming) writeMeal(db, prepareMeal(incoming), true);
      else db.run("DELETE FROM diary_meals WHERE id = ?", id);
      if (JSON.stringify(readMeal(db, id)) !== JSON.stringify(incoming)) {
        throw new Error("The meal projection changed while saving");
      }
    }
  }
  return groups.flat();
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
  DiaryStore & DiaryProgressStore & MyFoodsStore & PrivateArchiveStore & SyncDiaryStore
> {
  await migrateDiary(db, diaryMigrations, backupBeforeMigration, (connection) => {
    readMeals(connection.all(selectMeals));
    verifyDiaryProgress(connection);
    verifyMyFoods(connection);
  });
  const journal = openSyncJournal(db, () => requireCurrentDiaryVersion(db));
  const applyMeals = (
    changes: readonly StagedMealChange[],
    history: (id: string) => MealProjectionHistory,
  ) => projectMeals(db, changes, history);
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
      tryRebaseMeal: (session, id, submissionId) => {
        const mealId = diaryId(id, "meal ID");
        return journal.tryRebaseStalePut(
          session,
          { kind: "meal", id: mealId },
          submissionId,
          ({ base, draft, server }, hasOtherStagedMeal) => {
            const original = readRebaseMeal(base, mealId);
            const local = readRebaseMeal(draft, mealId);
            const remote = readRebaseMeal(server, mealId);
            if (!original || !local || !remote) return null;
            if (JSON.stringify(readMeal(db, mealId)) !== JSON.stringify(local)) return null;
            const originalItems = new Set(original.items.map(({ id }) => id));
            const membershipChanged =
              remote.items.length !== originalItems.size ||
              remote.items.some(({ id }) => !originalItems.has(id));
            if (membershipChanged && hasOtherStagedMeal()) return null;
            const result = reconcileDiaryMeal(original, local, remote);
            const merged = result.status === "merged" ? result.meal : null;
            if (
              !merged ||
              merged.items.some(({ id: itemId }) =>
                db.get("SELECT 1 FROM diary_items WHERE id = ? AND meal_id <> ?", itemId, mealId),
              )
            ) {
              return null;
            }
            return merged;
          },
          (content) => {
            const merged = readRebaseMeal(content, mealId);
            if (!merged) throw new Error("Invalid rebased meal");
            writeMeal(db, prepareMeal(merged), true);
            if (JSON.stringify(readMeal(db, mealId)) !== JSON.stringify(merged)) {
              throw new Error("The rebased meal changed while saving");
            }
          },
        );
      },
      applyMealPage: (session, cursor, page) =>
        journal.applyMealPage(session, cursor, page, applyMeals),
      applyMealResults: (session, results) => {
        journal.applyResults(session, results);
        return journal.replayMealProjections(session, applyMeals);
      },
      replayMealProjections: (session) => journal.replayMealProjections(session, applyMeals),
      saveWeighIn: (entry, submissionId) => {
        const reading = prepareWeighIn(entry);
        journal.commitLocalProjection({ kind: "weigh-in", id: reading.id }, submissionId, () => {
          writeWeighIn(db, reading);
          const row = db.get("SELECT * FROM diary_weigh_ins WHERE id = ?", reading.id);
          if (!row) throw new Error("Could not read the saved weigh-in for sync");
          return { op: "put", content: readWeighIn(row) };
        });
      },
      deleteWeighIn: (id, submissionId) => {
        const readingId = diaryId(id, "weigh-in ID");
        journal.commitLocalProjection({ kind: "weigh-in", id: readingId }, submissionId, () => {
          db.run("DELETE FROM diary_weigh_ins WHERE id = ?", readingId);
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

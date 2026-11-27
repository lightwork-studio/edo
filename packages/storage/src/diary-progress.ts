import type { DailyNutritionTarget, WeighIn } from "@edo/core";
import { inCurrentDiary } from "./migrations.ts";
import { diaryId, readDay, readInstant } from "./snapshot.ts";
import type { DiarySqliteConnection, SqlRow } from "./sqlite.ts";

export interface NutritionTargetRecord {
  /** Stable ID of one target revision. */
  readonly id: string;
  readonly effectiveDay: string;
  readonly configuredAt: number;
  readonly mode: "manual" | "calculated";
  readonly target: DailyNutritionTarget;
}

export interface DiaryProgressStore {
  saveWeighIn(entry: WeighIn): void;
  listWeighIns(from: string, through: string): WeighIn[];
  /** Save a new revision. An exact retry preserves the existing save order. */
  saveNutritionTarget(entry: NutritionTargetRecord): void;
  nutritionTargetAt(day: string): NutritionTargetRecord | null;
}

function positive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`Invalid diary ${field}`);
  }
  return value;
}

function grams(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`Invalid diary ${field}`);
  }
  return value;
}

function targetMode(value: unknown): NutritionTargetRecord["mode"] {
  if (value !== "manual" && value !== "calculated")
    throw new TypeError("Invalid diary target mode");
  return value;
}

function readWeighIn(row: SqlRow): WeighIn {
  return {
    id: diaryId(row.id, "weigh-in ID"),
    localDay: readDay(row.local_day),
    occurredAt: readInstant(row.occurred_at),
    kg: positive(row.kg, "weigh-in weight"),
  };
}

function readNutritionTarget(row: SqlRow): NutritionTargetRecord {
  return {
    id: diaryId(row.id, "target ID"),
    effectiveDay: readDay(row.effective_day),
    configuredAt: readInstant(row.configured_at),
    mode: targetMode(row.mode),
    target: {
      kcal: positive(row.kcal, "energy target"),
      proteinG: grams(row.protein_g, "protein target"),
      fatG: grams(row.fat_g, "fat target"),
      availableCarbohydratesG: grams(row.carbohydrate_g, "carbohydrate target"),
    },
  };
}

export function verifyDiaryProgress(db: DiarySqliteConnection): void {
  for (const row of db.all("SELECT * FROM diary_weigh_ins")) readWeighIn(row);
  for (const row of db.all("SELECT * FROM diary_targets")) readNutritionTarget(row);
}

export function diaryProgress(db: DiarySqliteConnection): DiaryProgressStore {
  return {
    saveWeighIn(entry) {
      const weighIn = readWeighIn({
        id: entry.id,
        local_day: entry.localDay,
        occurred_at: entry.occurredAt,
        kg: entry.kg,
      });
      inCurrentDiary(db, "BEGIN IMMEDIATE", () =>
        db.run(
          `INSERT INTO diary_weigh_ins VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET local_day = excluded.local_day,
             occurred_at = excluded.occurred_at, kg = excluded.kg`,
          weighIn.id,
          weighIn.localDay,
          weighIn.occurredAt,
          weighIn.kg,
        ),
      );
    },
    listWeighIns(from, through) {
      const first = readDay(from);
      const last = readDay(through);
      if (first > last) throw new RangeError("The weigh-in range ends before it starts");
      return inCurrentDiary(db, "BEGIN", () =>
        db
          .all(
            `SELECT * FROM diary_weigh_ins WHERE local_day BETWEEN ? AND ?
           ORDER BY local_day, occurred_at, id`,
            first,
            last,
          )
          .map(readWeighIn),
      );
    },
    saveNutritionTarget(entry) {
      const record = readNutritionTarget({
        id: entry.id,
        effective_day: entry.effectiveDay,
        configured_at: entry.configuredAt,
        mode: entry.mode,
        kcal: entry.target.kcal,
        protein_g: entry.target.proteinG,
        fat_g: entry.target.fatG,
        carbohydrate_g: entry.target.availableCarbohydratesG,
      });
      inCurrentDiary(db, "BEGIN IMMEDIATE", () => {
        const existing = db.get("SELECT * FROM diary_targets WHERE id = ?", record.id);
        if (existing) {
          if (JSON.stringify(readNutritionTarget(existing)) === JSON.stringify(record)) return;
          throw new Error("Changing a nutrition target requires a new revision ID");
        }
        db.run(
          `INSERT INTO diary_targets (
             id, effective_day, configured_at, mode, kcal, protein_g, fat_g, carbohydrate_g
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          record.id,
          record.effectiveDay,
          record.configuredAt,
          record.mode,
          record.target.kcal,
          record.target.proteinG,
          record.target.fatG,
          record.target.availableCarbohydratesG,
        );
      });
    },
    nutritionTargetAt(day) {
      const selected = readDay(day);
      return inCurrentDiary(db, "BEGIN", () => {
        const row = db.get(
          `SELECT * FROM diary_targets WHERE effective_day <= ?
           ORDER BY effective_day DESC, save_order DESC LIMIT 1`,
          selected,
        );
        return row ? readNutritionTarget(row) : null;
      });
    },
  };
}

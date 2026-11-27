import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDiaryItem, type Food } from "@edo/core";
import { openDiary } from "@edo/storage";
import { expect, test } from "vitest";
import { type CatalogDatabase, searchBls } from "../src/catalog";
import {
  entryTime,
  localDay,
  mondayOf,
  nextMidnight,
  readAmount,
  saveFood,
  totalNutrition,
} from "../src/diary-view";
import { appLocale } from "../src/strings";

function syntheticCatalog() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE catalog_metadata (singleton INTEGER PRIMARY KEY, release TEXT NOT NULL);
    INSERT INTO catalog_metadata VALUES (1, 'fixture-release');
    CREATE TABLE food (
      source_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      alternate_name TEXT NOT NULL,
      preparation TEXT NOT NULL,
      nutrition_basis TEXT NOT NULL,
      kcal REAL,
      protein_g REAL,
      available_carbohydrates_g REAL,
      fat_g REAL,
      fiber_g REAL
    );
    CREATE VIRTUAL TABLE food_search USING fts5(
      name, alternate_name, content='food', content_rowid='rowid'
    );
    INSERT INTO food VALUES
      ('test-apple', 'Apfel-Kräutertrunk', 'Apple herb drink', 'prepared', 'per-100-g', 40, 1, 8, NULL, 2),
      ('test-curd', 'Milchquarkcreme', 'Fresh curd cream', 'prepared', 'per-100-g', 60, 7, 4, 2, 0),
      ('test-grain', 'Haferkornbrot', '', 'prepared', 'per-100-g', 250, 7, 48, 2, 6);
    INSERT INTO food_search(food_search) VALUES ('rebuild');
  `);
  return db;
}

function catalogConnection(db: DatabaseSync): CatalogDatabase {
  return {
    async getAllAsync<T>(sql: string, parameter: string): Promise<T[]> {
      return db.prepare(sql).all(parameter) as T[];
    },
  };
}

function diaryConnection(db: DatabaseSync) {
  return openDiary({
    connection: {
      exec: (sql) => db.exec(sql),
      run: (sql, ...parameters) => {
        db.prepare(sql).run(...parameters);
      },
      all: (sql, ...parameters) => db.prepare(sql).all(...parameters),
      get: (sql, ...parameters) => db.prepare(sql).get(...parameters),
    },
    backupBeforeMigration: async () => {
      throw new Error("No prior version in this fixture");
    },
  });
}

test("searches both BLS name columns offline and localizes the displayed food name", async () => {
  using db = syntheticCatalog();
  const catalog = catalogConnection(db);
  const german = await searchBls(catalog, '"Apfel Kra\u0308uter"', "en");
  const english = await searchBls(catalog, "apple herb dri", "de");

  expect(german).toEqual([
    {
      id: { provider: "bls", sourceId: "test-apple" },
      name: "Apple herb drink",
      preparation: "prepared",
      release: "fixture-release",
      nutrition: {
        basis: "per-100-g",
        nutrients: { kcal: 40, proteinG: 1, availableCarbohydratesG: 8, fatG: null, fiberG: 2 },
      },
    },
  ]);
  expect(english).toEqual([
    expect.objectContaining({
      id: { provider: "bls", sourceId: "test-apple" },
      name: "Apfel-Kräutertrunk",
    }),
  ]);
  await expect(searchBls(catalog, "haferkorn", "en")).resolves.toEqual([
    expect.objectContaining({ name: "Haferkornbrot" }),
  ]);
  await expect(searchBls(catalog, 'zzedounmatched OR "apple"*', "en")).resolves.toEqual([]);
  await expect(searchBls(catalog, '"*-!', "de")).resolves.toEqual([]);
});

test("logs a past day, switches the default date at midnight and edits a reopened snapshot", async () => {
  const beforeMidnight = new Date(2026, 10, 29, 23, 59);
  const afterMidnight = new Date(nextMidnight(beforeMidnight));
  const historical = entryTime("2026-11-27", beforeMidnight);
  const before = entryTime(null, beforeMidnight);
  const after = entryTime(null, afterMidnight);
  const historicalTime = new Date(2026, 10, 27, 23, 59);
  expect(localDay(new Date(historical.occurredAt))).toBe(historical.day);
  expect(historical).toEqual({
    day: "2026-11-27",
    occurredAt: historicalTime.getTime(),
    utcOffsetMinutes: -historicalTime.getTimezoneOffset() || 0,
  });
  expect(before).toEqual({
    day: "2026-11-29",
    occurredAt: beforeMidnight.getTime(),
    utcOffsetMinutes: -beforeMidnight.getTimezoneOffset() || 0,
  });
  expect(after).toEqual({
    day: "2026-11-30",
    occurredAt: new Date(2026, 10, 30).getTime(),
    utcOffsetMinutes: -afterMidnight.getTimezoneOffset() || 0,
  });
  expect(mondayOf(before.day)).toBe("2026-11-23");
  expect(mondayOf(after.day)).toBe(after.day);

  using seed = syntheticCatalog();
  const catalog = catalogConnection(seed);
  const [apple] = await searchBls(catalog, "apfel", "de");
  const [curd] = await searchBls(catalog, "curd", "en");
  if (!apple || !curd) throw new Error("Expected fixture foods were missing");
  const directory = mkdtempSync(join(tmpdir(), "edo-offline-diary-"));
  const path = join(directory, "diary.db");
  let id = 0;
  const newId = () => `diary-${++id}`;
  const amount = readAmount("125,5");
  if (amount === null) throw new Error("Expected a decimal portion");

  try {
    {
      using db = new DatabaseSync(path);
      const diary = await diaryConnection(db);
      saveFood(diary, { kind: "add", ...historical, food: apple }, { amount, unit: "g" }, newId);
      saveFood(diary, { kind: "add", ...historical, food: curd }, { amount: 75, unit: "g" }, newId);
      saveFood(diary, { kind: "add", ...before, food: curd }, { amount: 100, unit: "g" }, newId);
      saveFood(diary, { kind: "add", ...after, food: curd }, { amount: 50, unit: "g" }, newId);
      const totals = totalNutrition(diary.listMeals(historical.day));
      expect(totals?.kcal).toBeCloseTo(95.2);
      expect(totals?.fatG).toBeNull();
      expect(totalNutrition(diary.listMeals(before.day))?.kcal).toBe(60);
      expect(totalNutrition(diary.listMeals(after.day))?.kcal).toBe(30);
    }
    {
      using db = new DatabaseSync(path);
      const diary = await diaryConnection(db);
      const [saved, other] = diary.listMeals(historical.day);
      expect(saved).toMatchObject({
        id: "diary-2",
        localDay: historical.day,
        occurredAt: historical.occurredAt,
        utcOffsetMinutes: historical.utcOffsetMinutes,
        items: [{ id: "diary-1", food: apple, portion: { amount: 125.5, unit: "g" } }],
      });

      const savedItem = saved?.items[0];
      if (!saved || !savedItem) throw new Error("Expected the saved diary entry");
      const captured = { ...savedItem, nutrients: { ...savedItem.nutrients, kcal: 51 } };
      diary.saveMeal({ ...saved, items: [captured] });
      const edit = {
        kind: "edit",
        day: historical.day,
        mealId: "diary-2",
        itemId: "diary-1",
      } as const;
      saveFood(diary, edit, captured.portion, newId);
      expect(diary.getMeal("diary-2")?.items[0]).toEqual(captured);

      saveFood(diary, edit, { amount: 75, unit: "g" }, () => {
        throw new Error("An edit keeps the original IDs");
      });
      expect(diary.getMeal("diary-2")).toMatchObject({
        localDay: historical.day,
        occurredAt: historical.occurredAt,
        utcOffsetMinutes: historical.utcOffsetMinutes,
        items: [
          {
            id: "diary-1",
            food: apple,
            portion: { amount: 75, unit: "g" },
            nutrients: { kcal: 30, fatG: null },
          },
        ],
      });
      expect(diary.getMeal("diary-4")).toEqual(other);
      expect(totalNutrition(diary.listMeals(historical.day))).toMatchObject({
        kcal: 75,
        fatG: null,
      });
    }
    using db = new DatabaseSync(path);
    const reopened = await diaryConnection(db);
    expect(totalNutrition(reopened.listMeals(historical.day))).toMatchObject({
      kcal: 75,
      fatG: null,
    });
    expect(totalNutrition(reopened.listMeals(after.day))?.kcal).toBe(30);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepts English and German decimal portions and rejects invalid quantities", () => {
  expect(readAmount("125.5")).toBe(125.5);
  expect(readAmount("125,5")).toBe(125.5);
  expect(readAmount(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  for (const invalid of ["", "0", "-5", "Infinity", "1,2,3", "100 g"]) {
    expect(readAmount(invalid)).toBeNull();
  }
});

test("keeps the historical day and the captured clock time across time zones", () => {
  const moduleUrl = new URL("../src/diary-view.ts", import.meta.url).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import assert from "node:assert/strict";
        import { entryTime, localDay, showTime } from ${JSON.stringify(moduleUrl)};
        const entry = entryTime("2024-03-30", new Date(2024, 3, 1, 23, 45));
        assert.equal(entry.day, "2024-03-30");
        assert.equal(localDay(new Date(entry.occurredAt)), entry.day);
        const occurredAt = Date.parse("2026-11-27T08:05:00Z");
        assert.equal(showTime({ occurredAt, utcOffsetMinutes: 60 }, "de-DE"), "09:05");
        assert.equal(showTime({ occurredAt, utcOffsetMinutes: 0 }, "de-DE"), "08:05");
        assert.equal(showTime({ occurredAt }, "de-DE"), "06:05");
      `,
    ],
    { env: { ...process.env, TZ: "America/Nuuk" } },
  );
});

test("keeps individual entries usable if their combined nutrients overflow", () => {
  const food: Food = {
    id: { provider: "local", sourceId: "synthetic-large-value" },
    release: null,
    name: "Synthetic food",
    preparation: "unknown",
    nutrition: {
      basis: "per-100-g",
      nutrients: { kcal: 1e308, proteinG: 1, availableCarbohydratesG: 1, fatG: 1, fiberG: 0 },
    },
  };
  const items = ["first", "second"].map((id) =>
    createDiaryItem(id, food, { amount: 100, unit: "g" }),
  );
  const meal = { id: "meal", localDay: "2026-11-27", occurredAt: 0, items };
  expect(totalNutrition([meal])).toBeNull();
  expect(totalNutrition([{ ...meal, items: items.slice(0, 1) }])?.kcal).toBe(1e308);
});

test("uses the first supported device language and keeps its regional locale", () => {
  expect(
    appLocale([
      { languageCode: "fr", languageTag: "fr-FR" },
      { languageCode: "de", languageTag: "de-AT" },
      { languageCode: "en", languageTag: "en-GB" },
    ]),
  ).toEqual({ language: "de", locale: "de-AT" });
  expect(appLocale([{ languageCode: "en", languageTag: "en-US" }])).toEqual({
    language: "en",
    locale: "en-US",
  });
  expect(appLocale([{ languageCode: "fr", languageTag: "fr-FR" }])).toEqual({
    language: "en",
    locale: "en-GB",
  });
});

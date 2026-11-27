import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { createDiaryItem, type Food } from "@edo/core";
import {
  type DiaryMeal,
  type DiarySqliteConnection,
  type NutritionTargetRecord,
  type OpenDiaryOptions,
  openDiary,
} from "@edo/storage";
import { afterEach, beforeEach, expect, test } from "vitest";
import { diaryMigrations, migrateDiary } from "../src/migrations.ts";
import { decodeSnapshot } from "../src/snapshot.ts";

const currentVersion = diaryMigrations.length;
let directory: string;
const databases: DatabaseSync[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "edo-diary-test-"));
});

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.isOpen) db.close();
  }
  rmSync(directory, { recursive: true, force: true });
});

function connectionFor(db: DatabaseSync): DiarySqliteConnection {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...parameters) => {
      db.prepare(sql).run(...parameters);
    },
    all: (sql, ...parameters) => db.prepare(sql).all(...parameters),
    get: (sql, ...parameters) => db.prepare(sql).get(...parameters),
  };
}

function createDatabase(name = "diary.db") {
  const path = join(directory, name);
  const db = new DatabaseSync(path);
  databases.push(db);
  const snapshots: string[] = [];
  const backupBeforeMigration: OpenDiaryOptions["backupBeforeMigration"] = async (
    version,
    verify,
  ) => {
    const source = new DatabaseSync(path, { readOnly: true });
    const destination = join(mkdtempSync(join(directory, "snapshot-")), `v${version}.db`);
    try {
      await backup(source, destination);
      const snapshot = new DatabaseSync(destination, { readOnly: true });
      try {
        verify(connectionFor(snapshot));
        snapshots.push(destination);
      } finally {
        snapshot.close();
      }
    } finally {
      source.close();
    }
  };
  const options: OpenDiaryOptions = {
    connection: connectionFor(db),
    backupBeforeMigration,
  };
  return { db, options, snapshots, start: () => openDiary(options) };
}

const sourceFood: Food = {
  id: { provider: "open-food-facts", sourceId: "00012345" },
  release: "fixture-a",
  name: "Soy drink",
  preparation: "as-sold",
  nutrition: {
    basis: "per-100-ml",
    nutrients: { kcal: 80, proteinG: 7, availableCarbohydratesG: 0, fatG: 3, fiberG: null },
    portionSize: { amount: 200, unit: "ml" },
    gramsPerMilliliter: 1.02,
  },
};

const meal: DiaryMeal = {
  id: "meal-night",
  localDay: "2026-10-31",
  occurredAt: Date.parse("2026-11-01T02:30:00Z"),
  items: [createDiaryItem("item-drink", sourceFood, { amount: 0.5, unit: "portion" })],
};

const weighIn = {
  id: "weigh-in",
  localDay: "2026-10-31",
  occurredAt: Date.parse("2026-11-01T02:30:00Z"),
  kg: 80,
};

const target: NutritionTargetRecord = {
  id: "target-one",
  effectiveDay: "2026-10-31",
  configuredAt: meal.occurredAt,
  mode: "manual",
  target: { kcal: 2000, proteinG: 110, fatG: 60, availableCarbohydratesG: 255 },
};

const revisedTarget: NutritionTargetRecord = {
  ...target,
  id: "target-two",
  configuredAt: target.configuredAt - 3_600_000,
  target: { ...target.target, kcal: 2100, availableCarbohydratesG: 280 },
};

test("reopens locally, preserving the event day, stable IDs and nutrition after a catalog refresh", async () => {
  const source = createDatabase();
  const diary = await source.start();
  diary.saveMeal(meal);
  diary.saveMeal(meal);
  source.db.close();

  const secondRelease: Food = {
    ...sourceFood,
    name: "Soy drink, new label",
    release: "fixture-b",
    nutrition: {
      ...sourceFood.nutrition,
      nutrients: { ...sourceFood.nutrition.nutrients, kcal: 120, fiberG: 2 },
    },
  };
  const reopened = await createDatabase().start();
  reopened.saveMeal({
    id: "meal-next",
    localDay: "2026-11-01",
    occurredAt: meal.occurredAt + 1,
    items: [createDiaryItem("item-next", secondRelease, { amount: 0.5, unit: "portion" })],
  });

  expect(reopened.listMeals("2026-10-31")).toEqual([meal]);
  expect(reopened.getMeal(meal.id)?.items[0]).toMatchObject({
    food: { id: { sourceId: "00012345" }, release: "fixture-a" },
    nutrients: { kcal: 80, availableCarbohydratesG: 0, fiberG: null },
  });
  expect(reopened.listMeals("2026-11-01")[0]?.items[0]?.nutrients).toMatchObject({
    kcal: 120,
    fiberG: 2,
  });
});

test("round-trips the captured offset for two occurrences of a DST wall time", async () => {
  const source = createDatabase();
  const diary = await source.start();
  const earlier: DiaryMeal = {
    ...meal,
    localDay: "2026-11-01",
    occurredAt: Date.parse("2026-11-01T05:30:00Z"),
    utcOffsetMinutes: -240,
  };
  const later: DiaryMeal = {
    id: "meal-fallback",
    localDay: earlier.localDay,
    occurredAt: Date.parse("2026-11-01T06:30:00Z"),
    utcOffsetMinutes: -300,
    items: [],
  };
  diary.saveMeal(earlier);
  diary.saveMeal(later);
  expect(() => diary.saveMeal({ ...earlier, utcOffsetMinutes: -240.5 })).toThrow(/UTC offset/);
  expect(() => diary.saveMeal({ ...earlier, utcOffsetMinutes: 1440 })).toThrow(/UTC offset/);
  source.db.close();

  const reopened = await createDatabase().start();
  expect(reopened.listMeals(earlier.localDay)).toEqual([earlier, later]);
  reopened.saveMeal({ ...earlier, utcOffsetMinutes: undefined });
  expect(reopened.getMeal(earlier.id)).toEqual(earlier);
  const moved = { ...earlier, occurredAt: later.occurredAt, utcOffsetMinutes: undefined };
  reopened.saveMeal(moved);
  expect(reopened.getMeal(earlier.id)?.utcOffsetMinutes).toBeUndefined();
});

test("deletes a meal and its items in a retryable transaction", async () => {
  const source = createDatabase();
  const diary = await source.start();
  diary.saveMeal(meal);
  diary.saveMeal({ ...meal, id: "other-meal", items: [] });
  diary.deleteMeal(meal.id);
  diary.deleteMeal(meal.id);
  source.db.close();

  const reopened = createDatabase();
  const restored = await reopened.start();
  expect(restored.getMeal(meal.id)).toBeNull();
  expect(restored.listMeals(meal.localDay).map(({ id }) => id)).toEqual(["other-meal"]);
  expect(reopened.options.connection.get("SELECT id FROM diary_items")).toBeUndefined();
});

test("migrates a version-one diary while preserving its snapshots and absent offset", async () => {
  const source = createDatabase();
  const { connection, backupBeforeMigration } = source.options;
  await migrateDiary(connection, diaryMigrations.slice(0, 1), backupBeforeMigration, () => {});
  connection.run(
    "INSERT INTO diary_meals VALUES (?, ?, ?)",
    meal.id,
    meal.localDay,
    meal.occurredAt,
  );
  const item = meal.items[0];
  if (!item) throw new Error("Expected a legacy diary item fixture");
  const { id, ...snapshot } = item;
  connection.run(
    "INSERT INTO diary_items VALUES (?, ?, 0, ?)",
    id,
    meal.id,
    JSON.stringify(snapshot),
  );

  const upgraded = await source.start();
  expect(upgraded.getMeal(meal.id)).toEqual(meal);
  expect(connection.get("PRAGMA user_version")?.user_version).toBe(currentVersion);
  expect(connection.get("PRAGMA application_id")?.application_id).toBe(0x45444f44);
  expect(source.snapshots).toHaveLength(1);
});

test("upgrades a published version-two diary and can restore its verified recovery copy", async () => {
  const current = createDatabase();
  const { connection } = current.options;
  // This is the published schema, including its identity and UTC offset field.
  connection.exec(`
    CREATE TABLE diary_meals (
      id TEXT PRIMARY KEY NOT NULL,
      local_day TEXT NOT NULL,
      occurred_at INTEGER NOT NULL
    );
    CREATE INDEX diary_meals_by_day ON diary_meals (local_day, occurred_at, id);
    CREATE TABLE diary_items (
      id TEXT PRIMARY KEY NOT NULL,
      meal_id TEXT NOT NULL REFERENCES diary_meals(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
      UNIQUE (meal_id, position)
    );
    ALTER TABLE diary_meals ADD COLUMN utc_offset_minutes INTEGER
      CHECK (utc_offset_minutes IS NULL OR
        (typeof(utc_offset_minutes) = 'integer' AND utc_offset_minutes BETWEEN -1439 AND 1439));
    PRAGMA application_id = 1162104644;
    PRAGMA user_version = 2;
  `);
  const fallBack = [
    {
      ...meal,
      id: "earlier-occurrence",
      localDay: "2026-11-01",
      occurredAt: Date.parse("2026-11-01T05:30:00Z"),
      utcOffsetMinutes: -240,
      items: [],
    },
    {
      ...meal,
      id: "later-occurrence",
      localDay: "2026-11-01",
      occurredAt: Date.parse("2026-11-01T06:30:00Z"),
      utcOffsetMinutes: -300,
      items: [],
    },
  ];
  for (const entry of [meal, ...fallBack]) {
    connection.run(
      "INSERT INTO diary_meals VALUES (?, ?, ?, ?)",
      entry.id,
      entry.localDay,
      entry.occurredAt,
      entry.utcOffsetMinutes ?? null,
    );
  }
  const item = meal.items[0];
  if (!item) throw new Error("Expected a captured item");
  const { id, ...captured } = item;
  connection.run(
    "INSERT INTO diary_items VALUES (?, ?, 0, ?)",
    id,
    meal.id,
    JSON.stringify(captured),
  );

  const upgraded = await current.start();
  expect(connection.get("PRAGMA user_version")?.user_version).toBe(3);
  expect(upgraded.getMeal(meal.id)).toEqual(meal);
  expect(upgraded.listMeals("2026-11-01")).toEqual(fallBack);
  expect(upgraded.listWeighIns("2026-10-31", "2026-11-01")).toEqual([]);
  expect(upgraded.nutritionTargetAt("2026-11-01")).toBeNull();

  const path = current.snapshots[0];
  if (!path) throw new Error("Expected a verified recovery copy");
  using snapshot = new DatabaseSync(path, { readOnly: true });
  expect(snapshot.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
  expect(
    snapshot.prepare("SELECT name FROM sqlite_schema WHERE name = 'diary_targets'").get(),
  ).toBeUndefined();
  await backup(snapshot, join(directory, "restored-v2.db"));
  const restored = await createDatabase("restored-v2.db").start();
  expect(restored.getMeal(meal.id)).toEqual(meal);
  expect(restored.listMeals("2026-11-01")).toEqual(fallBack);
});

test("saves offline weigh-ins and preserves effective target revisions in save order", async () => {
  const source = createDatabase();
  const diary = await source.start();
  diary.saveWeighIn(weighIn);
  diary.saveWeighIn({ ...weighIn, kg: 79 });
  expect(() => diary.saveWeighIn({ ...weighIn, kg: Infinity })).toThrow(/weight/);
  expect(() => diary.listWeighIns("2026-11-01", "2026-10-31")).toThrow(/range/);

  const future = { ...target, id: "future-target", effectiveDay: "2026-11-03" };
  diary.saveNutritionTarget(target);
  diary.saveNutritionTarget(revisedTarget);
  diary.saveNutritionTarget(target);
  diary.saveNutritionTarget(future);
  expect(() => diary.saveNutritionTarget({ ...target, mode: "calculated" })).toThrow(
    /new revision ID/,
  );
  expect(diary.nutritionTargetAt("2026-10-30")).toBeNull();
  expect(diary.nutritionTargetAt("2026-10-31")).toEqual(revisedTarget);
  expect(diary.nutritionTargetAt("2026-11-03")).toEqual(future);
  source.db.close();

  const reopened = await createDatabase().start();
  expect(reopened.listWeighIns("2026-10-31", "2026-10-31")).toEqual([{ ...weighIn, kg: 79 }]);
  expect(reopened.listWeighIns("2026-11-01", "2026-11-01")).toEqual([]);
  expect(reopened.nutritionTargetAt("2026-11-01")).toEqual(revisedTarget);
});

test("rejects a new target with an inconsistent energy budget", async () => {
  const diary = await createDatabase().start();
  diary.saveNutritionTarget(target);
  expect(() =>
    diary.saveNutritionTarget({
      ...revisedTarget,
      target: { ...revisedTarget.target, kcal: 1 },
    }),
  ).toThrow(/protein and fat exceed/i);
  expect(() =>
    diary.saveNutritionTarget({
      ...revisedTarget,
      target: { ...revisedTarget.target, availableCarbohydratesG: 1 },
    }),
  ).toThrow(/carbohydrate target/i);
  expect(diary.nutritionTargetAt(revisedTarget.effectiveDay)).toEqual(target);
  diary.saveNutritionTarget(revisedTarget);
  expect(diary.nutritionTargetAt(revisedTarget.effectiveDay)).toEqual(revisedTarget);
});

test.each(["weigh-in", "target", "save order"] as const)(
  "rejects a version-three backup with different progress %s values",
  async (difference) => {
    const source = createDatabase();
    const current = await source.start();
    const older = createDatabase("older.db");
    const stale = await older.start();
    current.saveMeal(meal);
    stale.saveMeal(meal);
    current.saveWeighIn(weighIn);
    stale.saveWeighIn(difference === "weigh-in" ? { ...weighIn, kg: 77 } : weighIn);
    current.saveNutritionTarget(target);
    current.saveNutritionTarget(revisedTarget);
    if (difference === "save order") stale.saveNutritionTarget(revisedTarget);
    stale.saveNutritionTarget(difference === "target" ? { ...target, mode: "calculated" } : target);
    if (difference !== "save order") stale.saveNutritionTarget(revisedTarget);

    await expect(
      migrateDiary(
        source.options.connection,
        [...diaryMigrations, (db) => db.exec("ALTER TABLE diary_meals ADD COLUMN memo TEXT")],
        async (_version, verify) => verify(older.options.connection),
        () => {},
      ),
    ).rejects.toThrow(/backup does not match/i);
    expect(source.options.connection.get("PRAGMA user_version")?.user_version).toBe(3);
    expect(current.listWeighIns("2026-10-31", "2026-10-31")).toEqual([weighIn]);
    expect(current.nutritionTargetAt("2026-10-31")).toEqual(revisedTarget);
  },
);

test.each([1, 2, currentVersion])(
  "rejects a version-%i catalog at the diary open boundary",
  async (version) => {
    const source = createDatabase();
    source.db.exec(
      `CREATE TABLE catalog_metadata (release TEXT); PRAGMA user_version = ${version}`,
    );
    await expect(source.start()).rejects.toThrow(/does not belong to the Edo diary/);
    expect(source.options.connection.get("PRAGMA user_version")?.user_version).toBe(version);
    expect(source.options.connection.all("SELECT name FROM sqlite_schema")).toEqual([
      { name: "catalog_metadata" },
    ]);
    expect(source.snapshots).toEqual([]);
  },
);

test("does not claim a database with lookalike version-one table names", async () => {
  const source = createDatabase();
  source.db.exec(`
    CREATE TABLE diary_meals (id TEXT PRIMARY KEY, local_day TEXT, occurred_at INTEGER);
    CREATE TABLE diary_items (id TEXT PRIMARY KEY, meal_id TEXT, position INTEGER, snapshot TEXT);
    INSERT INTO diary_meals VALUES ('other-app', '2026-10-31', 0);
    PRAGMA user_version = 1;
  `);
  await expect(source.start()).rejects.toThrow(/does not belong to the Edo diary/);
  const { connection } = source.options;
  expect(connection.get("PRAGMA user_version")?.user_version).toBe(1);
  expect(connection.get("PRAGMA application_id")?.application_id).toBe(0);
  expect(connection.get("SELECT id FROM diary_meals")?.id).toBe("other-app");
  expect(source.snapshots).toEqual([]);
});

test("rolls back all writes in an incomplete meal replacement", async () => {
  const source = createDatabase();
  const diary = await source.start();
  const otherItem = createDiaryItem("item-other", sourceFood, { amount: 50, unit: "ml" });
  const otherMeal = { ...meal, id: "meal-other", items: [otherItem] };
  diary.saveMeal(meal);
  diary.saveMeal(otherMeal);

  expect(() =>
    diary.saveMeal({
      ...meal,
      localDay: "2026-11-01",
      items: [createDiaryItem("item-new", sourceFood, { amount: 250, unit: "ml" }), otherItem],
    }),
  ).toThrow(/UNIQUE constraint failed/);
  source.db.close();

  const reopened = await createDatabase().start();
  expect(reopened.getMeal(meal.id)).toEqual(meal);
  expect(reopened.getMeal(otherMeal.id)).toEqual(otherMeal);
  expect(reopened.listMeals("2026-11-01")).toEqual([]);
});

test("updates a meal's stored portions, keeps stable item identities, and lists meals by instant", async () => {
  const diary = await createDatabase().start();
  diary.saveMeal(meal);
  const earlier = { ...meal, id: "meal-earlier", occurredAt: meal.occurredAt - 1, items: [] };
  diary.saveMeal(earlier);
  const items = [
    createDiaryItem("item-other", sourceFood, { amount: 50, unit: "ml" }),
    createDiaryItem("item-drink", sourceFood, { amount: 150, unit: "ml" }),
  ];
  diary.saveMeal({ ...meal, items });

  expect(diary.listMeals(meal.localDay)).toEqual([earlier, { ...meal, items }]);
  expect(diary.getMeal("missing")).toBeNull();
  expect(() => diary.saveMeal({ ...meal, localDay: "2026-02-29" })).toThrow(/calendar day/);
  expect(diary.getMeal(meal.id)).toEqual({ ...meal, items });
});

test("preserves well-formed Unicode IDs and refuses IDs SQLite would replace", async () => {
  const diary = await createDatabase().start();
  const replacementCharacter = {
    ...meal,
    id: "meal-\uFFFD",
    items: [createDiaryItem("item-\uFFFD", sourceFood, { amount: 50, unit: "ml" })],
  };
  const astral = {
    ...meal,
    id: "meal-🍽",
    items: [createDiaryItem("item-🍚", sourceFood, { amount: 100, unit: "ml" })],
  };
  diary.saveMeal(replacementCharacter);
  diary.saveMeal(astral);

  expect(() => diary.saveMeal({ ...replacementCharacter, id: "meal-\uD800", items: [] })).toThrow(
    /Invalid diary meal ID/,
  );
  expect(() => diary.getMeal("meal-\uD800")).toThrow(/Invalid diary meal ID/);
  expect(() =>
    diary.saveMeal({
      ...replacementCharacter,
      items: [createDiaryItem("item-\uDC00", sourceFood, { amount: 25, unit: "ml" })],
    }),
  ).toThrow(/Invalid diary item ID/);
  expect(diary.getMeal(replacementCharacter.id)).toEqual(replacementCharacter);
  expect(diary.getMeal(astral.id)).toEqual(astral);
});

test("backs up old data and rolls back invalid migrated rows before changing the version", async () => {
  const source = createDatabase();
  const diary = await source.start();
  source.db.exec("PRAGMA journal_mode = WAL");
  diary.saveMeal(meal);
  const editedMeal: DiaryMeal = {
    ...meal,
    items: [createDiaryItem("item-drink", sourceFood, { amount: 150, unit: "ml" })],
  };
  diary.saveMeal(editedMeal);
  const checkItems = (db: DiarySqliteConnection) => {
    for (const row of db.all("SELECT snapshot FROM diary_items")) {
      decodeSnapshot(row.snapshot);
    }
  };
  const { connection, backupBeforeMigration } = source.options;

  await expect(
    migrateDiary(
      connection,
      [
        ...diaryMigrations,
        (db) => {
          db.exec("ALTER TABLE diary_meals ADD COLUMN memo TEXT");
          db.run("UPDATE diary_items SET snapshot = ?", "{}");
        },
      ],
      backupBeforeMigration,
      checkItems,
    ),
  ).rejects.toThrow(/Invalid diary portion/);
  expect(connection.get("PRAGMA user_version")?.user_version).toBe(currentVersion);
  expect(connection.all("PRAGMA table_info(diary_meals)").map((row) => row.name)).not.toContain(
    "memo",
  );
  expect(diary.getMeal(meal.id)).toEqual(editedMeal);
  const snapshotPath = source.snapshots[0];
  if (!snapshotPath) throw new Error("Expected a verified recovery snapshot");
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    await backup(snapshot, join(directory, "restored-active.db"));
  } finally {
    snapshot.close();
  }
  const restored = await createDatabase("restored-active.db").start();
  expect(restored.getMeal(meal.id)).toEqual(editedMeal);

  await migrateDiary(
    connection,
    [...diaryMigrations, (db) => db.exec("ALTER TABLE diary_meals ADD COLUMN memo TEXT")],
    backupBeforeMigration,
    checkItems,
  );
  expect(connection.get("PRAGMA user_version")?.user_version).toBe(currentVersion + 1);
  const migratedItem = decodeSnapshot(connection.get("SELECT snapshot FROM diary_items")?.snapshot);
  expect({ id: "item-drink", ...migratedItem }).toEqual(editedMeal.items[0]);
  source.db.close();

  const upgraded = createDatabase();
  await expect(upgraded.start()).rejects.toThrow(/newer version/);
  expect(upgraded.options.connection.get("PRAGMA user_version")?.user_version).toBe(
    currentVersion + 1,
  );
  expect(source.snapshots).toHaveLength(2);
  const priorSnapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    expect(priorSnapshot.prepare("PRAGMA user_version").get()?.user_version).toBe(currentVersion);
    const previousItem = decodeSnapshot(
      priorSnapshot.prepare("SELECT snapshot FROM diary_items").get()?.snapshot,
    );
    expect({ id: "item-drink", ...previousItem }).toEqual(editedMeal.items[0]);
  } finally {
    priorSnapshot.close();
  }
});

test("rejects a silent incomplete backup and a stale copy with the correct version and row counts", async () => {
  const source = createDatabase();
  const store = await source.start();
  store.saveMeal(meal);
  const stale = createDatabase("stale.db");
  const staleStore = await stale.start();
  staleStore.saveMeal({
    ...meal,
    items: [
      createDiaryItem("item-drink", sourceFood, {
        amount: 25,
        unit: "ml",
      }),
    ],
  });
  const empty = createDatabase("incomplete.db");
  const steps = [
    ...diaryMigrations,
    (db: DiarySqliteConnection) => db.exec("ALTER TABLE diary_meals ADD COLUMN memo TEXT"),
  ];
  const backupAttempts: {
    backup: OpenDiaryOptions["backupBeforeMigration"];
    error: string;
  }[] = [
    { backup: async () => {}, error: "requires a verified backup" },
    {
      backup: async (_version, verify) => verify(empty.options.connection),
      error: "wrong storage version",
    },
    {
      backup: async (_version, verify) => verify(stale.options.connection),
      error: "does not match the current diary",
    },
  ];
  for (const attempt of backupAttempts) {
    await expect(
      migrateDiary(source.options.connection, steps, attempt.backup, () => {}),
    ).rejects.toThrow(attempt.error);
  }
  expect(source.options.connection.get("PRAGMA user_version")?.user_version).toBe(currentVersion);
  expect(
    source.options.connection.all("PRAGMA table_info(diary_meals)").map((row) => row.name),
  ).not.toContain("memo");
  expect(store.getMeal(meal.id)).toEqual(meal);
});

test("blocks reads and writes on an open handle after another connection upgrades the diary", async () => {
  const legacy = await createDatabase().start();
  legacy.saveMeal(meal);
  const upgraded = createDatabase();
  const { connection, backupBeforeMigration } = upgraded.options;
  await migrateDiary(
    connection,
    [
      ...diaryMigrations,
      (db) => {
        db.exec("ALTER TABLE diary_items ADD COLUMN memo TEXT");
        db.run("UPDATE diary_items SET memo = ? WHERE id = ?", "Retained note", "item-drink");
      },
    ],
    backupBeforeMigration,
    () => {},
  );

  expect(() => legacy.getMeal(meal.id)).toThrow(/version has changed/);
  expect(() => legacy.listMeals(meal.localDay)).toThrow(/version has changed/);
  expect(() => legacy.saveMeal({ ...meal, localDay: "2026-11-01" })).toThrow(/version has changed/);
  expect(() => legacy.deleteMeal(meal.id)).toThrow(/version has changed/);
  expect(() => legacy.listWeighIns(weighIn.localDay, weighIn.localDay)).toThrow(
    /version has changed/,
  );
  expect(() => legacy.saveWeighIn(weighIn)).toThrow(/version has changed/);
  expect(() => legacy.nutritionTargetAt(target.effectiveDay)).toThrow(/version has changed/);
  expect(() => legacy.saveNutritionTarget(target)).toThrow(/version has changed/);
  expect(connection.get("SELECT memo FROM diary_items WHERE id = ?", "item-drink")?.memo).toBe(
    "Retained note",
  );
  expect(connection.get("SELECT local_day FROM diary_meals WHERE id = ?", meal.id)?.local_day).toBe(
    meal.localDay,
  );
});

test("refuses to assume ownership of a populated, unversioned database", async () => {
  const source = createDatabase();
  source.db.exec("CREATE TABLE older_format (data); INSERT INTO older_format VALUES ('preserve')");
  await expect(source.start()).rejects.toThrow(/nonempty unversioned diary/);
  expect(source.options.connection.get("SELECT data FROM older_format")?.data).toBe("preserve");
  expect(source.options.connection.get("PRAGMA user_version")?.user_version).toBe(0);
});

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { planFddbDiaryImport } from "@edo/core";
import { openDiary } from "@edo/storage";
import { expect, test } from "vitest";

test("a planned FDDB import restores atomically and retains duplicate rows only once each", async () => {
  using sqlite = new DatabaseSync(":memory:");
  const diary = await openDiary({
    connection: {
      exec: (sql) => sqlite.exec(sql),
      run: (sql, ...params) => {
        sqlite.prepare(sql).run(...params);
      },
      all: (sql, ...params) => sqlite.prepare(sql).all(...params),
      get: (sql, ...params) => sqlite.prepare(sql).get(...params),
    },
    async backupBeforeMigration() {
      throw new Error("A blank diary needs no backup");
    },
  });
  const row = "27.11.2026 23:45;Soup;0000123;418,4;0;0;;";
  const csv = [
    "datum_tag_monat_jahr_stunde_minute;bezeichnung;interne_id;kj;kj_aktivitaeten;fett_g;kh_g;protein_g",
    row,
    row,
  ].join("\n");
  const plan = (timeZone: string) =>
    planFddbDiaryImport(csv, {
      timeZone,
      sha256: async (text) => createHash("sha256").update(text).digest("hex"),
    });
  const original = await plan("Europe/Berlin");
  expect(original.issues).toEqual([]);
  const archive = (meals: typeof original.meals) =>
    JSON.stringify({ format: "edo-diary", formatVersion: 1, meals });

  sqlite.exec(`CREATE TRIGGER interrupt_fddb BEFORE INSERT ON diary_items
    WHEN (SELECT count(*) FROM diary_items) > 0
    BEGIN SELECT RAISE(ABORT, 'simulated interrupted import'); END`);
  expect(() => diary.restorePrivateArchive(archive(original.meals))).toThrow(/interrupted import/);
  expect(diary.listMeals("2026-11-27")).toEqual([]);
  sqlite.exec("DROP TRIGGER interrupt_fddb");

  expect(diary.restorePrivateArchive(archive(original.meals))).toEqual({
    status: "restored",
    added: 2,
    alreadyPresent: 0,
  });
  expect(diary.restorePrivateArchive(archive((await plan("Europe/Berlin")).meals))).toEqual({
    status: "restored",
    added: 0,
    alreadyPresent: 2,
  });
  const differentZone = await plan("UTC");
  expect(diary.restorePrivateArchive(archive(differentZone.meals))).toMatchObject({
    status: "rejected",
    preview: {
      newRecords: 0,
      alreadyPresent: 0,
      issues: [
        { collection: "meals", index: 0 },
        { collection: "meals", index: 1 },
      ],
    },
  });
  expect(diary.listMeals("2026-11-27")).toEqual(original.meals);
});

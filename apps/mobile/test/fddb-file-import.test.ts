import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDiary } from "@edo/storage";
import { expect, test } from "vitest";
import {
  FddbPreparedSizeError,
  InvalidFddbSourceTimeZone,
  previewFddbFile,
} from "../src/fddb-file-import.ts";

const header =
  "datum_tag_monat_jahr_stunde_minute;bezeichnung;interne_id;kj;kj_aktivitaeten;fett_g;kh_g;protein_g";
const soup = "27.11.2026 23:45;Soup;0000123;418,4;0;0;;";
const source = [header, soup, soup, "27.11.2026 08:00;Walking;;;200;;;", "bad;Bread;;;;;;"].join(
  "\n",
);
const sha256 = async (text: string) => createHash("sha256").update(text).digest("hex");

test("previews FDDB rows in the selected zone and imports each occurrence once", async () => {
  using db = new DatabaseSync(":memory:");
  const diary = await openDiary({
    connection: {
      exec: (sql) => db.exec(sql),
      run: (sql, ...args) => {
        db.prepare(sql).run(...args);
      },
      all: (sql, ...args) => db.prepare(sql).all(...args),
      get: (sql, ...args) => db.prepare(sql).get(...args),
    },
    async backupBeforeMigration() {
      throw new Error("A blank diary needs no backup");
    },
  });
  const review = () => previewFddbFile(source, " Europe/Berlin ", diary, sha256);
  const preview = await review();
  expect(preview).toMatchObject({
    incompleteAtLine: null,
    storage: { newRecords: 2, alreadyPresent: 0, issues: [] },
    activityRows: 1,
    issues: [{ line: 5, code: "invalid-timestamp" }],
  });
  if (preview.archive === null) throw new Error("Expected an applicable export");
  expect(diary.listMeals("2026-11-27")).toEqual([]);
  expect(diary.restorePrivateArchive(preview.archive)).toEqual({
    status: "restored",
    added: 2,
    alreadyPresent: 0,
  });
  const meals = diary.listMeals("2026-11-27");
  expect(meals).toHaveLength(2);
  expect(new Set(meals.map(({ id }) => id)).size).toBe(2);
  for (const meal of meals) {
    expect(meal).toMatchObject({
      occurredAt: Date.parse("2026-11-27T22:45:00Z"),
      utcOffsetMinutes: 60,
      items: [{ nutrients: { fatG: 0, proteinG: null } }],
    });
    expect(meal.items[0]?.nutrients.kcal).toBeCloseTo(100);
  }
  expect((await review()).storage).toEqual({ newRecords: 0, alreadyPresent: 2, issues: [] });
  expect((await previewFddbFile(source, "UTC", diary, sha256)).storage).toMatchObject({
    newRecords: 0,
    issues: [
      { collection: "meals", index: 0 },
      { collection: "meals", index: 1 },
    ],
  });
});

test("returns no import payload when the CSV ends inside a quoted row", async () => {
  const bad = [
    header,
    soup,
    ...Array.from({ length: 13 }, () => "bad;Bread;;;;;;"),
    '27.11.2026 23:45;"incomplete',
  ].join("\n");
  const preview = await previewFddbFile(
    bad,
    "Europe/Berlin",
    {
      previewPrivateArchive: () => ({ newRecords: 1, alreadyPresent: 0, issues: [] }),
    },
    sha256,
  );
  expect(preview).toMatchObject({ archive: null, incompleteAtLine: 16 });
  expect(preview.issues.at(-1)).toEqual({ line: 16, code: "malformed-csv" });
});

test("bounds expanded archive text before the diary previews valid quoted rows", async () => {
  const row = `27.11.2026 23:45;"A${"\r\n".repeat(4_048)}B";0000123;418,4;0;0;;`;
  const source = [header, ...Array.from({ length: 1_050 }, () => row)].join("\n");
  await expect(
    previewFddbFile(
      source,
      "UTC",
      {
        previewPrivateArchive() {
          throw new Error("The diary must not preview an oversized archive");
        },
      },
      sha256,
    ),
  ).rejects.toBeInstanceOf(FddbPreparedSizeError);
});

test("rejects a missing or unsupported source time zone before previewing private records", async () => {
  for (const timeZone of [" ", "FDDB/Not-A-Zone"]) {
    await expect(
      previewFddbFile(
        source,
        timeZone,
        {
          previewPrivateArchive: () => {
            throw new Error("Invalid time zone should prevent preview");
          },
        },
        sha256,
      ),
    ).rejects.toBeInstanceOf(InvalidFddbSourceTimeZone);
  }
});

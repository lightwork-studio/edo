import { createHash } from "node:crypto";
import { planFddbDiaryImport } from "@edo/core";
import { expect, test } from "vitest";

const header =
  "datum_tag_monat_jahr_stunde_minute;bezeichnung;interne_id;kj;kj_aktivitaeten;fett_g;kh_g;protein_g";
const sha256 = async (text: string) => createHash("sha256").update(text).digest("hex");
const berlin = { timeZone: "Europe/Berlin", sha256 };

test("uses the chosen time zone and reports ambiguous and skipped wall times", async () => {
  const input = [
    header,
    "30.03.2025 02:30;Skipped;0001;41,84;0;0;0;0",
    "26.10.2025 02:30;Repeated;0002;83,68;0;0;0;0",
    "26.10.2025 00:15;Food before midnight UTC;0003;;0;0;;",
    "26.10.2025 03:30;Food after transition;0003;125,52;0;;;;",
    "26.10.2025 04:30;Food with fractional nutrition;0004;418,4;0;0;;2,5",
    "26.10.2025 04:40;Exercise;;0;80;0;0;0",
  ].join("\n");
  const result = await planFddbDiaryImport(input, berlin);
  expect(result.issues).toEqual([
    { line: 2, code: "missing-time" },
    { line: 3, code: "ambiguous-time" },
    { line: 5, code: "wrong-column-count" },
  ]);
  expect(result.activityRows).toBe(1);
  expect(result.meals).toMatchObject([
    {
      localDay: "2025-10-26",
      occurredAt: Date.parse("2025-10-25T22:15:00Z"),
      utcOffsetMinutes: 120,
      items: [
        {
          portion: { amount: 1, unit: "portion" },
          food: { name: "Food before midnight UTC", nutrition: { basis: "per-portion" } },
          nutrients: { kcal: null, fatG: 0, fiberG: null, proteinG: null },
        },
      ],
    },
    {
      localDay: "2025-10-26",
      occurredAt: Date.parse("2025-10-26T03:30:00Z"),
      utcOffsetMinutes: 60,
      items: [{ nutrients: { kcal: expect.closeTo(100, 10), proteinG: 2.5, fiberG: null } }],
    },
  ]);
});

test("keeps IDs stable across repeated and overlapping imports while preserving duplicate rows", async () => {
  const repeated = "27.11.2026 09:00;Food;0001;41,84;0;;;";
  const different = "27.11.2026 08:00;Other food;0002;83,68;0;;;";
  const source = [header, repeated, repeated].join("\n");
  const first = await planFddbDiaryImport(source, berlin);
  expect(first.issues).toEqual([]);
  expect(first.meals).toHaveLength(2);
  expect(first.meals[0]?.id).not.toBe(first.meals[1]?.id);
  expect(first.meals[0]?.items[0]?.id).not.toBe(first.meals[1]?.items[0]?.id);
  expect(first.meals[0]?.items[0]?.food.id).toEqual(first.meals[1]?.items[0]?.food.id);
  expect(await planFddbDiaryImport(source, berlin)).toEqual(first);
  const larger = await planFddbDiaryImport(
    [header, repeated, different, repeated].join("\r\n"),
    berlin,
  );
  expect([larger.meals[0], larger.meals[2]]).toEqual(first.meals);

  const kolkata = await planFddbDiaryImport(source, { ...berlin, timeZone: "Asia/Kolkata" });
  expect(kolkata.meals[0]).toMatchObject({
    id: first.meals[0]?.id,
    occurredAt: Date.parse("2026-11-27T03:30:00Z"),
    utcOffsetMinutes: 330,
  });
  await expect(planFddbDiaryImport(source, { ...berlin, timeZone: "" })).rejects.toThrow(
    /time zone/,
  );
});

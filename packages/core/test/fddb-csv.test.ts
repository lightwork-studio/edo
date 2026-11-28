import { FddbCsvRecordLimitError, previewFddbDiaryCsv } from "@edo/core";
import { expect, test } from "vitest";

const header =
  "datum_tag_monat_jahr_stunde_minute;bezeichnung;interne_id;kj;kj_aktivitaeten;fett_g;kh_g;protein_g";

test("counts activity and invalid non-blank records toward the optional preview limit", () => {
  const file = [header, "", "27.11.2026 08:00;Walking;;;200;;;", "invalid;Bread;;;;;;"].join("\n");
  expect(previewFddbDiaryCsv(file, 2)).toMatchObject({
    activityRows: 1,
    issues: [{ line: 4, code: "invalid-timestamp" }],
  });
  expect(() => previewFddbDiaryCsv(file, 1)).toThrow(FddbCsvRecordLimitError);
});

test("previews German FDDB export rows without inventing a timezone or missing nutrients", () => {
  const input = [
    `\uFEFF${header}`,
    '25.10.2026 02:30;"Soja; ""natur""\n200 ml";000123;418,4;0;2,5;0;7',
    "25.10.2026 08:30;FoodScan;;41,84;;;0;0",
    "25.10.2026 08:30;FoodScan;;41,84;;;0;0",
    "",
  ].join("\r\n");
  const result = previewFddbDiaryCsv(input);
  expect(result.issues).toEqual([]);
  expect(result.activityRows).toBe(0);
  expect(result.rows).toHaveLength(3);
  expect(result.rows[0]).toEqual({
    line: 2,
    localDay: "2026-10-25",
    localTime: "02:30",
    name: 'Soja; "natur"\n200 ml',
    sourceFoodId: "000123",
    nutrients: {
      kcal: expect.closeTo(100, 10),
      fatG: 2.5,
      availableCarbohydratesG: 0,
      proteinG: 7,
      fiberG: null,
    },
  });
  expect(result.rows[1]).toMatchObject({
    line: 4,
    sourceFoodId: null,
    nutrients: { kcal: 10, fatG: null, availableCarbohydratesG: 0, proteinG: 0 },
  });
  expect(result.rows[2]?.line).toBe(5);
});

test("separates activity rows and reports invalid food rows by line", () => {
  const result = previewFddbDiaryCsv(
    [
      header,
      "27.11.2026 09:00;Walk;;0;200;0;0;0",
      "27.11.2026 09:00;Mixed;;20;200;0;0;0",
      "31.02.2026 09:00;Soup;;20;0;0;0;0",
      "27.11.2026 09:00;Soup;;abc;0;0;0;0",
      "27.11.2026 09:00;  ;;20;0;0;0;0",
      "27.11.2026 09:00;short row",
      "27.11.2026 09:00;Valid;;41,84;0;0;0;0",
    ].join("\n"),
  );
  expect(result.activityRows).toBe(1);
  expect(result.issues).toEqual([
    { line: 3, code: "mixed-food-and-activity" },
    { line: 4, code: "invalid-timestamp" },
    { line: 5, code: "invalid-nutrition" },
    { line: 6, code: "missing-food-name" },
    { line: 7, code: "wrong-column-count" },
  ]);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ line: 8, nutrients: { kcal: 10 } });
});

test("rejects unknown headers and stops after an unsafe record boundary", () => {
  expect(previewFddbDiaryCsv("time;food;kcal\n09:00;Soup;100")).toEqual({
    rows: [],
    activityRows: 0,
    issues: [{ line: 1, code: "unsupported-header" }],
  });
  const result = previewFddbDiaryCsv(
    `${header}\n27.11.2026 09:00;Soup;;418,4;0;0;0;0\n27.11.2026 10:00;"unterminated`,
  );
  expect(result.rows).toHaveLength(1);
  expect(result.issues).toEqual([{ line: 3, code: "malformed-csv" }]);
});

test("keeps a named row with all nutrition fields unavailable", () => {
  const result = previewFddbDiaryCsv(`${header}\n27.11.2026 09:00;Soup;;;;;;`);
  expect(result.issues).toEqual([]);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]?.nutrients).toEqual({
    kcal: null,
    proteinG: null,
    availableCarbohydratesG: null,
    fatG: null,
    fiberG: null,
  });
});

test("keeps completed rows before a large unterminated quoted field", () => {
  const result = previewFddbDiaryCsv(
    `${header}\n27.11.2026 09:00;Soup;;418,4;0;0;0;0\n27.11.2026 10:00;"${"a".repeat(16_000_000)}`,
  );
  expect(result.rows).toHaveLength(1);
  expect(result.issues).toEqual([{ line: 3, code: "malformed-csv" }]);
});

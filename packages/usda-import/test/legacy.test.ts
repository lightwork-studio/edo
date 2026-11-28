import { expect, test } from "vitest";
import { mapLegacyFoods, previewLegacyArchive } from "../src/legacy.ts";

function csv(...rows: string[][]) {
  const lines = rows.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

const fixture = {
  food: csv(
    ["fdc_id", "data_type", "description", "food_category_id", "publication_date"],
    ["2", "sr_legacy_food", 'Food, "prepared"\r\nserving', "3", "2019-04-01"],
    ["1", "sr_legacy_food", "Unreported food", "3", "2019-04-01"],
  ),
  legacyFood: csv(["fdc_id", "NDB_number"], ["1", "233"], ["2", "000123"]),
  nutrient: csv(
    ["id", "name", "unit_name", "nutrient_nbr", "rank"],
    ["1005", "Carbohydrate by difference", "G", "205", "1"],
    ["1008", "Energy", "KCAL", "208", "2"],
    ["1079", "Fiber", "G", "291", "3"],
  ),
  derivation: csv(["id", "code", "description", "source_id"], ["1", "A", "Analytical", "1"]),
  foodNutrient: csv(
    [
      "id",
      "fdc_id",
      "nutrient_id",
      "amount",
      "data_points",
      "derivation_id",
      "min",
      "max",
      "median",
      "footnote",
      "min_year_acquired",
    ],
    ["1", "2", "1008", "42", "1", "1", "", "", "", "", ""],
    ["2", "2", "1005", "8.25", "1", "", "", "", "", "", ""],
    ["3", "2", "1079", "0", "1", "1", "", "", "", "", ""],
  ),
};

test("retains linked legacy identifiers, quoted descriptions and raw nutrient values", () => {
  const [absent, food] = mapLegacyFoods(fixture);
  expect(absent).toMatchObject({
    fdcId: 1,
    nutrition: { nutrients: { kcal: null, fiberG: null, availableCarbohydratesG: null } },
  });
  expect(food).toMatchObject({
    fdcId: 2,
    ndbNumber: "000123",
    description: 'Food, "prepared"\r\nserving',
    publicationDate: "2019-04-01",
    energyNutrientId: 1008,
    nutrition: {
      basis: "per-100-g",
      nutrients: { kcal: 42, fiberG: 0, availableCarbohydratesG: null },
    },
    carbohydrateByDifferenceG: 8.25,
    sourceMeasurements: [
      { nutrientId: 1005, amount: 8.25, derivationCode: null },
      { nutrientId: 1008, amount: 42, derivationCode: "A" },
      { nutrientId: 1079, amount: 0, derivationCode: "A" },
    ],
  });
});

test("refuses a substituted ZIP, malformed CSV and missing or duplicated mappings", () => {
  expect(() => previewLegacyArchive(new Uint8Array(6074592))).toThrow("pinned release");
  expect(() => mapLegacyFoods({ ...fixture, food: `${fixture.food}"3, broken` })).toThrow(
    "Unclosed SR Legacy CSV field",
  );
  expect(() =>
    mapLegacyFoods({ ...fixture, nutrient: fixture.nutrient.replace("KCAL", "KJ") }),
  ).toThrow("Invalid or duplicate SR Legacy nutrient definition");
  expect(() =>
    mapLegacyFoods({ ...fixture, derivation: fixture.derivation.replace('"1","A"', '"90","A"') }),
  ).toThrow("Unmatched SR Legacy nutrient reference");
  expect(() =>
    mapLegacyFoods({
      ...fixture,
      foodNutrient:
        fixture.foodNutrient + csv(["4", "2", "1079", "1", "1", "1", "", "", "", "", ""]),
    }),
  ).toThrow("Duplicate SR Legacy nutrient measurement");
});

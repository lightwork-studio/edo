import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { CatalogDatabase } from "@edo/catalog-import/bls-search";
import { expect, test } from "vitest";
import { resolveBlsMealDraft } from "../src/bls-meal-draft.ts";

const seedPath = fileURLToPath(new URL("../../mobile/assets/bls.sqlite", import.meta.url));

function catalog(db: DatabaseSync): CatalogDatabase {
  return {
    async getAllAsync<T>(sql: string, parameter: string): Promise<T[]> {
      return db.prepare(sql).all(parameter) as T[];
    },
  };
}

test("uses the shipped bilingual catalog and preserves declared portions and source order", async () => {
  using db = new DatabaseSync(seedPath, { readOnly: true });
  const germanName = "Apfelkuchen Sandmasse";
  const englishName = "Apple pie sand batter";
  const stated = { amount: 125.5, unit: "g", quality: "stated" };
  const estimate = { amount: 0.5, unit: "portion", quality: "estimated" };
  const german = await resolveBlsMealDraft(
    catalog(db),
    [
      { name: germanName, portion: stated, confidence: 0.95 },
      { name: "Zirkonquarzphantasiesuppe", portion: null, confidence: null },
      { name: germanName, portion: estimate, confidence: 0.4 },
    ],
    "de",
  );
  const english = await resolveBlsMealDraft(
    catalog(db),
    [{ name: englishName, portion: stated, confidence: 0.95 }],
    "en",
  );

  const id = { provider: "bls", sourceId: "D130100" };
  expect(german).toMatchObject([
    {
      name: germanName,
      portion: stated,
      confidence: 0.95,
      catalog: { state: "matches", choices: [{ id, name: "Apfelkuchen (Sandmasse)" }] },
    },
    {
      name: "Zirkonquarzphantasiesuppe",
      portion: null,
      confidence: null,
      catalog: { state: "no-match" },
    },
    {
      name: germanName,
      portion: estimate,
      confidence: 0.4,
      catalog: { state: "matches", choices: [{ id }] },
    },
  ]);
  const [item] = english;
  expect(item).toMatchObject({
    name: englishName,
    portion: stated,
    catalog: {
      state: "matches",
      choices: [{ id, name: "Apple pie (sand cake batter)", release: "4.0-2025" }],
    },
  });
});

test("keeps ambiguous food choices bounded and distinguishes an unavailable catalog", async () => {
  const item = { name: "Apfel", portion: null, confidence: 0.7 };
  using db = new DatabaseSync(seedPath, { readOnly: true });
  const [draft] = await resolveBlsMealDraft(catalog(db), [item], "de");
  expect(draft?.catalog).toMatchObject({ state: "matches", hasMore: true });
  if (draft?.catalog.state !== "matches") throw new Error("Expected ambiguous BLS results");
  expect(draft.catalog.choices).toHaveLength(5);
  expect(new Set(draft.catalog.choices.map(({ id }) => id.sourceId)).size).toBe(5);

  const closed = new DatabaseSync(seedPath, { readOnly: true });
  closed.close();
  await expect(resolveBlsMealDraft(catalog(closed), [item], "de")).resolves.toEqual([
    { ...item, catalog: { state: "unavailable" } },
  ]);
});

test("validates the entire extraction before issuing any catalog queries", async () => {
  let lookups = 0;
  const db: CatalogDatabase = {
    async getAllAsync() {
      lookups += 1;
      return [];
    },
  };
  const item = { name: "Banane", portion: null, confidence: 0.8 };
  const badExtractions = [
    Array.from({ length: 17 }, () => item),
    [item, { ...item, name: "a".repeat(161) }],
    [item, { ...item, confidence: 1.01 }],
    [item, { ...item, confidence: Number.NaN }],
    [item, { ...item, portion: { amount: 0, unit: "g", quality: "estimated" } }],
    [item, { ...item, portion: { amount: 2, unit: "servings", quality: "stated" } }],
    [item, { ...item, additionalField: true }],
    [item, null],
  ];
  for (const extraction of badExtractions) {
    await expect(resolveBlsMealDraft(db, extraction, "de")).rejects.toThrow(TypeError);
  }
  await expect(resolveBlsMealDraft(db, [], "de")).resolves.toEqual([]);
  expect(lookups).toBe(0);
});

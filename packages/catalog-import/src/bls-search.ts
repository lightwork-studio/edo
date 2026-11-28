import type { Food } from "@edo/core";

export type BlsSearchLanguage = "de" | "en";

interface CatalogFood {
  source_id: string;
  name: string;
  alternate_name: string;
  release: string;
  preparation: Food["preparation"];
  nutrition_basis: Food["nutrition"]["basis"];
  kcal: number | null;
  protein_g: number | null;
  available_carbohydrates_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
}

export interface CatalogDatabase {
  getAllAsync<T>(sql: string, parameter: string): Promise<T[]>;
}

function catalogFood(row: CatalogFood, language: BlsSearchLanguage): Food {
  return {
    id: { provider: "bls", sourceId: row.source_id },
    name: language === "de" ? row.name : row.alternate_name || row.name,
    release: row.release,
    preparation: row.preparation,
    nutrition: {
      basis: row.nutrition_basis,
      nutrients: {
        kcal: row.kcal,
        proteinG: row.protein_g,
        availableCarbohydratesG: row.available_carbohydrates_g,
        fatG: row.fat_g,
        fiberG: row.fiber_g,
      },
    },
  };
}

export async function searchBls(
  db: CatalogDatabase,
  query: string,
  language: BlsSearchLanguage,
): Promise<Food[]> {
  // Quote individual words so typed input cannot become FTS syntax.
  const words = query.normalize("NFC").match(/[\p{L}\p{N}\p{M}]+/gu);
  if (!words) return [];
  const match = words.map((word) => `"${word}"*`).join(" AND ");
  const rows = await db.getAllAsync<CatalogFood>(
    `SELECT food.*, catalog_metadata.release
     FROM food_search
     JOIN food ON food.rowid = food_search.rowid
     JOIN catalog_metadata ON catalog_metadata.singleton = 1
     WHERE food_search MATCH ?
     ORDER BY rank, food.source_id
     LIMIT 50`,
    match,
  );
  return rows.map((row) => catalogFood(row, language));
}

export async function findBlsFoods(
  db: CatalogDatabase,
  ids: readonly string[],
  language: BlsSearchLanguage,
): Promise<Food[]> {
  if (ids.length === 0) return [];
  const rows = await db.getAllAsync<CatalogFood>(
    `SELECT food.*, catalog_metadata.release
     FROM food JOIN catalog_metadata ON catalog_metadata.singleton = 1
     WHERE food.source_id IN (SELECT value FROM json_each(?))
     ORDER BY food.source_id`,
    JSON.stringify(ids),
  );
  return rows.map((row) => catalogFood(row, language));
}

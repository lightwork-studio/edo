import { access, open, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { CatalogBuilder, CatalogManifest } from "@edo/catalog-import";
import { blsAttribution, readBlsArchive } from "./workbook.ts";

export const blsSeedSchemaVersion = 1;

const schema = `
  PRAGMA user_version = ${blsSeedSchemaVersion};
  CREATE TABLE catalog_metadata (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    provider TEXT NOT NULL,
    release TEXT NOT NULL,
    source_url TEXT NOT NULL,
    attribution TEXT NOT NULL,
    license_url TEXT NOT NULL,
    changes TEXT NOT NULL
  ) STRICT;
  CREATE TABLE food (
    source_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    alternate_name TEXT NOT NULL,
    preparation TEXT NOT NULL,
    nutrition_basis TEXT NOT NULL,
    kcal REAL,
    protein_g REAL,
    available_carbohydrates_g REAL,
    fat_g REAL,
    fiber_g REAL
  ) STRICT;
  CREATE VIRTUAL TABLE food_search USING fts5(
    name, alternate_name, content='food', content_rowid='rowid'
  );
`;

type SeedCounts = CatalogManifest["counts"];

async function buildSeed(
  inputPath: string,
  artifactPath: string,
  release: string,
  expectedSha256?: string,
): Promise<number> {
  const foods = await readBlsArchive(inputPath, release, expectedSha256);
  const output = await open(artifactPath, "wx", 0o600);
  await output.close();

  try {
    const db = new DatabaseSync(artifactPath);
    try {
      db.exec("BEGIN");
      db.exec(schema);

      db.prepare(`
        INSERT INTO catalog_metadata
          (singleton, provider, release, source_url, attribution, license_url, changes)
        VALUES (1, 'bls', ?, ?, ?, ?, ?)
      `).run(
        release,
        blsAttribution.sourceUrl,
        blsAttribution.name,
        blsAttribution.licenseUrl,
        blsAttribution.changes,
      );

      const insert = db.prepare(`
        INSERT INTO food (source_id, name, alternate_name, preparation, nutrition_basis,
                          kcal, protein_g, available_carbohydrates_g, fat_g, fiber_g)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const food of foods) {
        const { basis, nutrients } = food.nutrition;
        insert.run(
          food.id.sourceId,
          food.name,
          food.englishName,
          food.preparation,
          basis,
          nutrients.kcal,
          nutrients.proteinG,
          nutrients.availableCarbohydratesG,
          nutrients.fatG,
          nutrients.fiberG,
        );
      }

      db.exec("INSERT INTO food_search(food_search) VALUES ('rebuild')");
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  } catch (error) {
    await rm(artifactPath, { force: true });
    throw error;
  }

  return foods.length;
}

async function validateSeed(
  artifactPath: string,
  release: string,
  counts: SeedCounts,
): Promise<void> {
  // The FTS5 integrity command uses INSERT syntax even though it validates a staged artifact.
  await access(artifactPath);
  const db = new DatabaseSync(artifactPath);
  try {
    if (db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check !== "ok") {
      throw new Error("BLS seed SQLite integrity check failed");
    }
    if (db.prepare("PRAGMA user_version").get()?.user_version !== blsSeedSchemaVersion) {
      throw new Error("BLS seed schema version does not match");
    }
    const metadata = db
      .prepare("SELECT provider, release FROM catalog_metadata WHERE singleton = 1")
      .get();
    if (metadata?.provider !== "bls" || metadata.release !== release) {
      throw new Error("BLS seed metadata does not match the expected release");
    }
    const rowCount = db.prepare("SELECT count(*) AS count FROM food").get()?.count;
    if (rowCount !== counts.accepted || counts.accepted < 1 || counts.rejected !== 0) {
      throw new Error("BLS seed row count does not match");
    }

    // rank=1 also compares the index to its external content table.
    db.exec("INSERT INTO food_search(food_search, rank) VALUES ('integrity-check', 1)");
  } finally {
    db.close();
  }
}

/** Adapter for the catalog publisher's private staging and validation pipeline. */
export function createBlsCatalogBuilder(release: string, expectedSha256?: string): CatalogBuilder {
  return {
    async build(inputPath: string, artifactPath: string): Promise<SeedCounts> {
      const accepted = await buildSeed(inputPath, artifactPath, release, expectedSha256);
      return { accepted, rejected: 0 };
    },
    async validate(artifactPath: string, counts: SeedCounts): Promise<void> {
      await validateSeed(artifactPath, release, counts);
    },
  };
}

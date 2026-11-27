import { DatabaseSync } from "node:sqlite";
import {
  type CatalogManifest,
  compatibleCatalog,
  matchesCatalogDatabaseMetadata,
  publishCatalog,
  restoreCatalogRelease,
} from "@edo/catalog-import";
import { readOpenFoodFactsExport } from "./read.ts";

export const openFoodFactsCatalog = {
  provider: "open-food-facts",
  schemaVersion: 1,
  importerVersion: "2",
  sourceUrl: "https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz",
} as const;
const { provider, schemaVersion, importerVersion, sourceUrl } = openFoodFactsCatalog;
const notice = {
  name: "Open Food Facts contributors",
  license: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  changes:
    "Selected German-market foods, preserved source IDs, indexed names and barcodes, and omitted nutrition values inconsistent with declared mass.",
};

export function compatibleOpenFoodFactsManifest(value: unknown): CatalogManifest | null {
  const manifest = compatibleCatalog(value, provider, [schemaVersion]);
  return manifest?.source.url === sourceUrl &&
    manifest.attribution.name === notice.name &&
    manifest.attribution.license === notice.license
    ? manifest
    : null;
}

export function matchesOpenFoodFactsDatabase(database: DatabaseSync, manifest: CatalogManifest) {
  return (
    manifest.provider === provider &&
    matchesCatalogDatabaseMetadata(database, manifest, notice.licenseUrl)
  );
}

export function restoreOpenFoodFactsRelease(root: string, manifestSha256: string) {
  return restoreCatalogRelease(root, provider, manifestSha256, (database, manifest) => {
    if (!compatibleOpenFoodFactsManifest(manifest)) {
      throw new Error("Unsupported Open Food Facts catalog manifest");
    }
    if (!matchesOpenFoodFactsDatabase(database, manifest)) {
      throw new Error("Open Food Facts catalog metadata does not match its manifest");
    }
    validateOpenFoodFactsRows(database, manifest.counts.accepted);
  });
}

function validateOpenFoodFactsRows(database: DatabaseSync, accepted: number): void {
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  const rows = database
    .prepare(
      "SELECT (SELECT COUNT(*) FROM food) AS food, (SELECT COUNT(*) FROM barcode) AS barcode",
    )
    .get();
  if (foreignKeys.length > 0 || rows?.food !== accepted || rows?.barcode !== accepted) {
    throw new Error("Open Food Facts catalog failed integrity or row validation");
  }
}

const schema = `
  CREATE TABLE catalog_metadata (
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
    alternate_name TEXT,
    preparation TEXT NOT NULL,
    nutrition_basis TEXT,
    kcal REAL,
    protein_g REAL,
    available_carbohydrates_g REAL,
    fat_g REAL,
    fiber_g REAL,
    portion_amount REAL,
    portion_unit TEXT
  ) STRICT;
  CREATE TABLE barcode (
    source_id TEXT PRIMARY KEY NOT NULL REFERENCES food (source_id),
    code TEXT NOT NULL,
    lookup_code TEXT NOT NULL
  ) STRICT;
  PRAGMA user_version = ${schemaVersion};
`;

interface OpenFoodFactsRelease {
  root: string;
  /** Publisher timestamp or another stable identifier for the downloaded export. */
  release: string;
  lastModified?: string;
}

export interface OpenFoodFactsImport extends OpenFoodFactsRelease {
  inputPath: string;
}

interface OpenFoodFactsRefresh extends OpenFoodFactsRelease {
  prepareInput(destination: string): Promise<void>;
  minimumAccepted?: number;
}

/** Publish a complete export while the caller holds the Open Food Facts job lock. */
export async function publishOpenFoodFactsRelease(
  input: OpenFoodFactsImport | OpenFoodFactsRefresh,
): Promise<CatalogManifest> {
  return publishCatalog(
    {
      ...input,
      provider,
      schemaVersion,
      importerVersion,
      source: { release: input.release, url: sourceUrl, lastModified: input.lastModified },
      attribution: notice,
    },
    {
      async build(inputPath, artifactPath) {
        using database = new DatabaseSync(artifactPath);
        database.exec(schema);
        database
          .prepare("INSERT INTO catalog_metadata VALUES (?, ?, ?, ?, ?, ?)")
          .run(provider, input.release, sourceUrl, notice.name, notice.licenseUrl, notice.changes);
        const insert = database.prepare(`
          INSERT INTO food VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (source_id) DO NOTHING
        `);
        const insertBarcode = database.prepare("INSERT INTO barcode VALUES (?, ?, ?)");
        database.exec("BEGIN");
        const counts = await readOpenFoodFactsExport(inputPath, input.release, (product) => {
          const nutrition = product.food.nutrition;
          const values = nutrition?.nutrients;
          const result = insert.run(
            product.food.id.sourceId,
            product.food.name,
            product.nameDe ? product.nameEn : null,
            product.food.preparation,
            nutrition?.basis ?? null,
            values?.kcal ?? null,
            values?.proteinG ?? null,
            values?.availableCarbohydratesG ?? null,
            values?.fatG ?? null,
            values?.fiberG ?? null,
            nutrition?.portionSize?.amount ?? null,
            nutrition?.portionSize?.unit ?? null,
          );
          if (Number(result.changes) !== 1) return false;
          insertBarcode.run(product.food.id.sourceId, product.barcode, product.lookupCode);
          return true;
        });
        database.exec(`
          CREATE INDEX barcode_lookup ON barcode (lookup_code);
          CREATE VIRTUAL TABLE food_search USING fts5(
            name, alternate_name, content='food', content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
          );
          INSERT INTO food_search(food_search) VALUES ('rebuild');
          INSERT INTO food_search(food_search, rank) VALUES ('integrity-check', 1);
          COMMIT;
        `);
        return counts;
      },
      async validate(artifactPath, counts) {
        if (
          "minimumAccepted" in input &&
          input.minimumAccepted !== undefined &&
          counts.accepted < input.minimumAccepted
        ) {
          throw new Error(
            `Open Food Facts refresh accepted ${counts.accepted} products, below the minimum of ${input.minimumAccepted}`,
          );
        }
        using database = new DatabaseSync(artifactPath, { readOnly: true });
        const integrity = database.prepare("PRAGMA integrity_check").get();
        if (integrity?.integrity_check !== "ok") {
          throw new Error("Open Food Facts catalog failed integrity or row validation");
        }
        validateOpenFoodFactsRows(database, counts.accepted);
      },
    },
  );
}

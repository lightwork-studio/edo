import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const input = process.argv[2];
if (!input) throw new Error("Specify the verified public SQLite catalog");
using db = new DatabaseSync(input, { readOnly: true });
const metadata = db.prepare("SELECT provider, release FROM catalog_metadata").get();
if (metadata.provider !== "open-food-facts") throw new Error("Unexpected catalog provider");

const rows = db
  .prepare(
    `WITH ordered AS (
       SELECT source_id, code, row_number() OVER (ORDER BY lookup_code, source_id) AS sample_row
       FROM barcode
     )
     SELECT food.*, ordered.code
     FROM ordered JOIN food USING (source_id)
     WHERE sample_row % 17 = 1
     ORDER BY sample_row LIMIT 20000`,
  )
  .all();
const products = rows.map((row) => ({
  id: { provider: metadata.provider, sourceId: row.source_id },
  barcode: row.code,
  name: row.name,
  alternateName: row.alternate_name,
  release: metadata.release,
  preparation: row.preparation,
  nutrition: row.nutrition_basis
    ? {
        basis: row.nutrition_basis,
        nutrients: {
          kcal: row.kcal,
          proteinG: row.protein_g,
          availableCarbohydratesG: row.available_carbohydrates_g,
          fatG: row.fat_g,
          fiberG: row.fiber_g,
        },
        ...(row.portion_amount !== null && {
          portionSize: { amount: row.portion_amount, unit: row.portion_unit },
        }),
      }
    : null,
}));
const bytes = products.reduce(
  (total, product) => total + Buffer.byteLength(JSON.stringify(product)),
  0,
);
console.log(`Sampled ${products.length} public products totaling ${bytes} payload bytes`);
if (products.length < 8000 || bytes < 5 * 1024 * 1024)
  throw new Error("The fixture must exceed the mobile cache budget");
writeFileSync(
  "apps/mobile/verify/off-cache-products.ts",
  `import type { PackagedFood } from "@edo/core";\nexport const products = JSON.parse(${JSON.stringify(JSON.stringify(products))}) as PackagedFood[];\n`,
);

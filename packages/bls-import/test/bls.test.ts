import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { publishCatalog } from "@edo/catalog-import";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  blsAttribution,
  blsWorkbookEntry,
  createBlsCatalogBuilder,
  publishBlsCatalog,
  readBlsArchive,
  readBlsWorkbook,
} from "../src/index.ts";

type FixtureCell = string | number | null;

const workbookNamespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const documentRelationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";

const headers = [
  "FAT Datenherkunft",
  "Food name",
  "CHO Kohlenhydrate, verfügbar [g/100g]",
  "BLS Code",
  "PROT625 Protein [g/100g]",
  "Lebensmittelbezeichnung",
  "ENERCC Referenz",
  "ENERCC Energie [kcal/100g]",
  "FAT Fett [g/100g]",
  "FIBT Ballaststoffe [g/100g]",
];

function xml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function workbook(rows: readonly (readonly FixtureCell[])[]): Uint8Array {
  const sheetRows = rows
    .map((row, index) => {
      const number = index + 1;
      const cells = row
        .map((value, column) => {
          const address = String.fromCharCode(65 + column) + number;
          if (value === null) return "";
          if (typeof value === "number") return `<c r="${address}"><v>${value}</v></c>`;
          return `<c r="${address}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${number}">${cells}</row>`;
    })
    .join("");

  return zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${documentRelationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<workbook xmlns="${workbookNamespace}" xmlns:r="${documentRelationships}"><sheets><sheet name="BLS_4_0_Daten_2025_DE" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${documentRelationships}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<worksheet xmlns="${workbookNamespace}"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
  });
}

const cooked = [
  "synthetic",
  "Grain, cooked",
  23.3,
  "FAKE-b",
  "TR",
  "Korn, gekocht",
  "-",
  151,
  "<LOD or <LOQ",
  3.125,
];
const raw = ["synthetic", "Grain, raw", 0, "000001", 12.345, "Korn & Öl, roh", "-", 401, 7.123, 0];

const directories: string[] = [];
async function fixture(name: string, bytes: Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "edo-bls-test-"));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("BLS 4.0 workbook import", () => {
  it("maps codes and units independently of column or row order", async () => {
    const bytes = workbook([headers, cooked, [null, null, null, null, null], raw]);
    const path = await fixture(
      "release.zip",
      zipSync({ [blsWorkbookEntry]: bytes, "unrelated.xlsx": strToU8("unused") }),
    );

    expect(await readBlsArchive(path, "4.0-synthetic")).toEqual([
      {
        id: { provider: "bls", sourceId: "000001" },
        release: "4.0-synthetic",
        name: "Korn & Öl, roh",
        englishName: "Grain, raw",
        preparation: "raw",
        nutrition: {
          basis: "per-100-g",
          nutrients: {
            kcal: 401,
            proteinG: 12.345,
            availableCarbohydratesG: 0,
            fatG: 7.123,
            fiberG: 0,
          },
        },
      },
      {
        id: { provider: "bls", sourceId: "FAKE-b" },
        release: "4.0-synthetic",
        name: "Korn, gekocht",
        englishName: "Grain, cooked",
        preparation: "cooked",
        nutrition: {
          basis: "per-100-g",
          nutrients: {
            kcal: 151,
            proteinG: null,
            availableCarbohydratesG: 23.3,
            fatG: null,
            fiberG: 3.125,
          },
        },
      },
    ]);
  });

  it("keeps an unreported nutrient distinct from a genuine zero", async () => {
    const path = await fixture(
      "release.xlsx",
      workbook([headers, ["test", "Soup", 0, "test01", "<LOD", "Suppe", "-", 20, "-", null]]),
    );
    const [food] = await readBlsWorkbook(path, "4.0-synthetic");
    expect(food?.preparation).toBe("unknown");
    expect(food?.nutrition.nutrients).toEqual({
      kcal: 20,
      proteinG: null,
      availableCarbohydratesG: 0,
      fatG: null,
      fiberG: null,
    });
  });

  it("retains explicit raw and cooked preparations and leaves conflicting names unknown", async () => {
    const withNames = (id: string, de: string, en: string) =>
      raw.map((cell, index) => (index === 3 ? id : index === 5 ? de : index === 1 ? en : cell));
    const path = await fixture(
      "release.xlsx",
      workbook([
        headers,
        withNames("A", "Beispiel roh", "Example raw"),
        withNames("B", "Beispiel tiefgefroren, gedämpft", "Example frozen, steamed"),
        withNames("C", "Beispiel roh", "Example cooked"),
        withNames(
          "D",
          "Beispiel, gekocht, gebraten ohne Fett",
          "Example boiled, fried without fat",
        ),
        withNames("E", "Beispiel, gebraten im Ofen", "Example fried in oven"),
        withNames("F", "Beispiel mit gebratenem Gemüse", "Example with roasted vegetables"),
        withNames("G", "Beispiel (roh) mit Öl", "Example (raw) with oil"),
        withNames("H", "Beispiel (gegart) mit Öl", "Example (cooked) with oil"),
        withNames("I", "Beispiel, gebacken (Ofen)", "Example, baked (oven)"),
        withNames("J", "Lachs, pochiert", "Salmon, poached"),
        withNames("K", "Kabeljau, gargezogen", "Cod in stock"),
        withNames("L", "Bratkartoffeln aus rohen Kartoffeln", "Fried potatoes (of raw potatoes)"),
        withNames("M", "Vorzugsmilch", "Certified raw milk"),
        withNames("N", "Soße mit pochiertem Ei", "Sauce with poached egg"),
        withNames("O", "Leber nach Berliner Art", "Liver fried Berlin style"),
        withNames("P", "Tomaten nach provenzalischer Art", "Tomatoes baked Provencal style"),
        withNames("Q", "Karpfen polnisch", "Carp poached Polish style"),
        withNames("R", "Fisch, gebraten amerikanischer Art", "American fish"),
        withNames("S", "Auster, gratiniert im Ofen", "Oyster gratinated in oven"),
        withNames("T", "Wurst, gebrüht", "Sausage scalded"),
        withNames("U", "Rinderbraten", "Braised beef roast"),
        withNames("V", "Kartoffel geschält, druckgedämpft", "Peeled potato, pressure-steamed"),
        withNames("W", "Zwiebelwurst", "Cooked sausage with onions"),
        withNames("X", "Ofenkartoffeln mit Zwiebeln", "Baked potatoes with onions"),
        withNames("Y", "Brathering Konserve", "Fried herring canned"),
        withNames("Z", "Beispiel roh", "Cooked sausage"),
        withNames("ZA", "Milchreis mit Banane roh", "Rice pudding with milk and raw banana"),
        withNames(
          "ZB",
          "Grießbrei mit Erdbeersauce roh",
          "Semolina pudding with raw strawberry sauce",
        ),
        withNames("ZC", "Reismischung mit Wildreis, roh", "Rice mix with wild rice, raw"),
      ]),
    );
    const foods = await readBlsWorkbook(path, "4.0-synthetic");
    expect(foods.map((food) => food.preparation)).toEqual([
      "raw",
      "cooked",
      "unknown",
      "cooked",
      "cooked",
      "unknown",
      "raw",
      "cooked",
      "cooked",
      "cooked",
      "cooked",
      "cooked",
      "raw",
      "unknown",
      "cooked",
      "cooked",
      "cooked",
      "cooked",
      "cooked",
      "cooked",
      "cooked",
      "cooked",
      "cooked",
      "cooked",
      "cooked",
      "unknown",
      "unknown",
      "unknown",
      "raw",
    ]);
  });

  it("rejects a duplicate source ID with its row number", async () => {
    const path = await fixture("release.xlsx", workbook([headers, cooked, cooked]));
    await expect(readBlsWorkbook(path, "4.0-synthetic")).rejects.toThrow(
      /row 3:.*Duplicate BLS Code FAKE-b/,
    );
  });

  it("rejects a nutrient column with an unexpected unit", async () => {
    const changedHeaders = headers.map((header) =>
      header.startsWith("CHO ") ? "CHO Kohlenhydrate [mg/100g]" : header,
    );
    const path = await fixture("release.xlsx", workbook([changedHeaders, cooked]));
    await expect(readBlsWorkbook(path, "4.0-synthetic")).rejects.toThrow(
      /row 1:.*Missing BLS column CHO/,
    );
  });

  it("rejects an undocumented nutrient text value", async () => {
    const changed = cooked.map((value, index) => (index === 4 ? "1.5g" : value));
    const path = await fixture("release.xlsx", workbook([headers, changed]));
    await expect(readBlsWorkbook(path, "4.0-synthetic")).rejects.toThrow(/row 2:.*PROT625/);
  });

  it("finds the expected workbook inside the release archive", async () => {
    const wrongArchive = zipSync({ "unexpected.xlsx": workbook([headers, cooked]) });
    const path = await fixture("release.zip", wrongArchive);
    await expect(readBlsArchive(path, "4.0-synthetic")).rejects.toThrow(/missing BLS_4_0/);
  });
});

describe("BLS SQLite seed", () => {
  it("ships the reviewed release with readable bilingual search and preparation", async () => {
    const path = fileURLToPath(new URL("../../../apps/mobile/assets/bls.sqlite", import.meta.url));
    const bytes = await readFile(path);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "de019d3c43f8836e678d6eb32584ba1280fc2b0fe9c2ee6fb033af73c17cdf05",
    );
    using db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(db.prepare("SELECT count(*) AS n FROM food").get()?.n).toBe(7140);
    expect(db.prepare("SELECT * FROM catalog_metadata").get()).toMatchObject({
      provider: "bls",
      release: "4.0-2025",
      source_url: blsAttribution.sourceUrl,
      license_url: blsAttribution.licenseUrl,
    });
    const search = db.prepare(`
      SELECT preparation FROM food_search JOIN food ON food.rowid = food_search.rowid
      WHERE food_search MATCH ? AND source_id = 'T410132'
    `);
    expect(search.get('"Lachs"*')).toMatchObject({ preparation: "cooked" });
    expect(search.get('"Salmon"*')).toMatchObject({ preparation: "cooked" });
  });

  it("reproduces its bytes and opens read-only with bilingual search and provenance", async () => {
    const source = await fixture(
      "release.zip",
      zipSync({ [blsWorkbookEntry]: workbook([headers, cooked, raw]) }),
    );
    const first = join(dirname(source), "first.sqlite");
    const second = join(dirname(source), "second.sqlite");
    const builder = createBlsCatalogBuilder("4.0-synthetic");

    const firstResult = await builder.build(source, first);
    const secondResult = await builder.build(source, second);
    await builder.validate(first, firstResult);
    await builder.validate(second, secondResult);
    expect(firstResult).toEqual({ accepted: 2, rejected: 0 });
    expect(secondResult).toEqual(firstResult);
    expect(await readFile(first)).toEqual(await readFile(second));
    await expect(builder.build(source, first)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(first)).toEqual(await readFile(second));

    const db = new DatabaseSync(first, { readOnly: true });
    try {
      const match = db.prepare(`
        SELECT food.source_id, food.kcal FROM food_search
        JOIN food ON food.rowid = food_search.rowid
        WHERE food_search MATCH ?
      `);
      expect(match.all("ol*")).toEqual([{ source_id: "000001", kcal: 401 }]);
      expect(match.all('"grain cooked"')).toEqual([{ source_id: "FAKE-b", kcal: 151 }]);
      expect(db.prepare("SELECT protein_g FROM food WHERE source_id = ?").get("FAKE-b")).toEqual({
        protein_g: null,
      });
      expect(
        db.prepare("SELECT provider, release, source_url, license_url FROM catalog_metadata").get(),
      ).toEqual({
        provider: "bls",
        release: "4.0-synthetic",
        source_url: blsAttribution.sourceUrl,
        license_url: "https://creativecommons.org/licenses/by/4.0/",
      });
    } finally {
      db.close();
    }
  });

  it("rejects a staged artifact whose search index no longer matches its records", async () => {
    const source = await fixture(
      "release.zip",
      zipSync({ [blsWorkbookEntry]: workbook([headers, cooked]) }),
    );
    const output = join(dirname(source), "damaged.sqlite");
    const builder = createBlsCatalogBuilder("4.0-synthetic");
    const result = await builder.build(source, output);
    await builder.validate(output, result);

    const db = new DatabaseSync(output);
    try {
      db.exec("UPDATE food SET name = 'Different'");
    } finally {
      db.close();
    }
    await expect(builder.validate(output, result)).rejects.toThrow();
  });

  it("publishes the staged seed and preserves it if a release fails the pinned checksum", async () => {
    const source = await fixture(
      "release.zip",
      zipSync({ [blsWorkbookEntry]: workbook([headers, cooked, raw]) }),
    );
    const root = join(dirname(source), "catalog");
    const release = "4.0-synthetic";
    const manifest = await publishCatalog(
      {
        root,
        inputPath: source,
        provider: "bls",
        schemaVersion: 1,
        importerVersion: "test",
        source: { release, url: "https://example.test/release" },
        attribution: { name: "Synthetic test", license: "Test", changes: "Test" },
      },
      createBlsCatalogBuilder(release),
    );
    const active = join(root, "bls", "active.json");
    const savedManifest = await readFile(active, "utf8");
    expect(JSON.parse(savedManifest)).toEqual(manifest);
    expect(manifest.counts).toEqual({ accepted: 2, rejected: 0 });
    await expect(publishBlsCatalog(source, root)).rejects.toThrow(/pinned SHA-256/);
    expect(await readFile(active, "utf8")).toBe(savedManifest);

    const file = join(root, "bls", "artifacts", `${manifest.artifact.sha256}.sqlite`);
    const reader = new DatabaseSync(file, { readOnly: true });
    try {
      expect(reader.prepare("SELECT release FROM catalog_metadata").get()).toEqual({ release });
    } finally {
      reader.close();
    }
  });
});

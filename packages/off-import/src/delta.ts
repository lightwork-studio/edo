import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { type CatalogManifest, publishCatalog } from "@edo/catalog-import";
import { copyVerifiedCatalog, readCatalogManifestFile } from "./catalog-snapshot.ts";
import { readOpenFoodFactsProduct } from "./format.ts";
import {
  compatibleOpenFoodFactsManifest,
  insertOpenFoodFactsProduct,
  matchesOpenFoodFactsDatabase,
  openFoodFactsCatalog,
  openFoodFactsNotice,
  validateOpenFoodFactsRows,
} from "./publish.ts";
import { readOpenFoodFactsLines } from "./read.ts";
import { runCatalogJob } from "./worker.ts";

const { provider, importerVersion, schemaVersion, deltaIndexUrl, sourceUrl } = openFoodFactsCatalog;
const deltaRelease = /^off-delta-v1:(\d+):([a-f0-9]{64})$/;
const maxDeltaBytes = 256 * 1024 * 1024;

interface Window {
  name: string;
  start: number;
  end: number;
}

function digest(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function windowsAfter(index: string, cursor: number, now: number): Window[] {
  const windows = index
    .trim()
    .split(/\r?\n/)
    .map((name) => {
      const match = /^openfoodfacts_products_(\d{1,10})_(\d{1,10})\.json\.gz$/.exec(name);
      const start = Number(match?.[1]);
      const end = Number(match?.[2]);
      if (!(start > 0 && end > start && end <= now)) {
        throw new Error("Invalid Open Food Facts delta window");
      }
      return { name, start, end };
    })
    .sort((a, b) => a.start - b.start);
  const planned = windows.filter(({ end }) => end > cursor);
  if (planned.length === 0) {
    if (windows.at(-1)?.end === cursor) return [];
    throw new Error("Open Food Facts delta index is behind the saved checkpoint");
  }
  let expected = cursor;
  for (const window of planned) {
    if (window.start !== expected) {
      throw new Error("Open Food Facts delta windows are missing or overlap");
    }
    expected = window.end;
  }
  return planned;
}

async function fetchDelta(url: string, fetcher: typeof fetch, timeout: number): Promise<Response> {
  const response = await fetcher(url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
    headers: { "User-Agent": "Edo/1 (https://github.com/lightwork-studio/edo)" },
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(`Open Food Facts delta request returned HTTP ${response.status}`);
  }
  return response;
}

async function readIndex(fetcher: typeof fetch): Promise<string> {
  const response = await fetchDelta(deltaIndexUrl, fetcher, 30_000);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing Open Food Facts delta index");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      size += result.value.length;
      if (size > 8_192) throw new Error("Open Food Facts delta index is too large");
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function download(window: Window, scratch: string, fetcher: typeof fetch) {
  const url = new URL(window.name, deltaIndexUrl).href;
  const response = await fetchDelta(url, fetcher, 5 * 60_000);
  if (!response.body) throw new Error("Missing Open Food Facts delta body");
  const path = join(scratch, window.name);
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    response.body,
    async function* (chunks: AsyncIterable<Uint8Array>) {
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > maxDeltaBytes) throw new Error("Open Food Facts delta is too large");
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
  );
  return { ...window, path, url, sha256: hash.digest("hex"), bytes };
}

function checkpoint(source: CatalogManifest["source"], start: number | undefined) {
  const update = source.url === deltaIndexUrl ? deltaRelease.exec(source.release) : null;
  if (update) {
    if (start !== undefined) throw new Error("The catalog already has a delta checkpoint");
    const cursor = Number(update[1]);
    if (Date.parse(source.lastModified ?? "") !== cursor * 1000) {
      throw new Error("Open Food Facts delta checkpoint does not match its release timestamp");
    }
    return cursor;
  }
  const snapshotTime = Date.parse(source.lastModified ?? "") / 1000;
  if (
    source.url !== sourceUrl ||
    start === undefined ||
    !Number.isSafeInteger(start) ||
    start <= 0 ||
    !(start < snapshotTime)
  ) {
    throw new Error("Bootstrap requires a known checkpoint before a timestamped full export");
  }
  return start;
}

function parseRecord(line: string, window: Window) {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Open Food Facts delta product");
  }
  const row = value as Record<string, unknown>;
  const id = typeof row._id === "string" && row._id.trim() ? row._id.trim() : row.code;
  const modified = row.last_modified_t;
  if (
    typeof id !== "string" ||
    !id.trim() ||
    !id.isWellFormed() ||
    id.includes("\0") ||
    typeof modified !== "number" ||
    !Number.isSafeInteger(modified) ||
    modified <= window.start ||
    modified > window.end
  ) {
    throw new Error("Invalid Open Food Facts delta product ID or timestamp");
  }
  if (
    row.deleted !== true &&
    row.deleted !== "on" &&
    (typeof row.code !== "string" ||
      !row.code.trim() ||
      typeof row.rev !== "number" ||
      !Number.isSafeInteger(row.rev) ||
      row.rev < 1 ||
      [row.product_name_de, row.product_name_en, row.product_name].some(
        (name) =>
          name != null && (typeof name !== "string" || !name.isWellFormed() || name.includes("\0")),
      ) ||
      (row.countries_tags !== undefined &&
        (!Array.isArray(row.countries_tags) ||
          row.countries_tags.some((country) => typeof country !== "string"))))
  ) {
    throw new Error("Incomplete Open Food Facts delta product");
  }
  return { row, id: id.trim() };
}

async function applyWindows(
  database: DatabaseSync,
  windows: Awaited<ReturnType<typeof download>>[],
  release: string,
) {
  const removeBarcode = database.prepare("DELETE FROM barcode WHERE source_id = ?");
  const removeFood = database.prepare("DELETE FROM food WHERE source_id = ?");
  const insertFood = insertOpenFoodFactsProduct(database);
  let skipped = 0;
  let rejected = 0;
  for (const window of windows) {
    const ids = new Set<string>();
    await readOpenFoodFactsLines(
      window.path,
      (line) => {
        if (!line.trim()) return;
        const { row, id } = parseRecord(line, window);
        if (ids.has(id)) throw new Error("Open Food Facts delta contains duplicate product IDs");
        ids.add(id);
        const product = readOpenFoodFactsProduct(row, release);
        removeBarcode.run(id);
        removeFood.run(id);
        if (product === "outside-scope") skipped += 1;
        else if (!product) rejected += 1;
        else if (product.food.id.sourceId !== id || !insertFood(product)) {
          throw new Error("Open Food Facts delta product could not be written");
        }
      },
      { maxLineLength: 16 * 1024 * 1024, strictUtf8: true },
    );
  }

  const accepted = database.prepare("SELECT COUNT(*) AS count FROM food").get()?.count;
  if (typeof accepted !== "number") throw new Error("Could not count the updated catalog");
  return { accepted, rejected, skipped };
}

/** Apply every available delta after the committed checkpoint as one new catalog release. */
export async function refreshOpenFoodFactsDeltas(
  root: string,
  options: { bootstrapFrom?: number; fetcher?: typeof fetch; now?: Date } = {},
): Promise<{ status: "published" | "unchanged"; cursor: number; manifest: CatalogManifest }> {
  const { bootstrapFrom, fetcher = fetch, now = new Date() } = options;
  return runCatalogJob(root, async (providerRoot) => {
    const scratch = join(providerRoot, ".delta-work");
    // This directory holds only worker scratch. The job lock has no surviving owner after a crash.
    await rm(scratch, { recursive: true, force: true });
    const current = await readCatalogManifestFile(join(providerRoot, "active.json"));
    const baseline = compatibleOpenFoodFactsManifest(JSON.parse(current.toString("utf8")));
    if (!baseline || baseline.importerVersion !== importerVersion) {
      throw new Error("A verified Open Food Facts baseline from the current importer is required");
    }
    const parent = digest(current);
    const archived = await readCatalogManifestFile(
      join(providerRoot, "releases", `${parent}.json`),
    );
    if (!archived.equals(current)) throw new Error("Open Food Facts baseline manifest has changed");
    const cursor = checkpoint(baseline.source, bootstrapFrom);
    const windows = windowsAfter(
      await readIndex(fetcher),
      cursor,
      Math.floor(now.getTime() / 1000),
    );
    const through = windows.at(-1)?.end ?? cursor;
    if (bootstrapFrom !== undefined) {
      const adjacent = windows[0];
      if (!adjacent || adjacent.end * 1000 < Date.parse(baseline.source.lastModified ?? "")) {
        throw new Error("Bootstrap requires the delta window adjacent to the full export");
      }
    }

    await mkdir(scratch, { mode: 0o700 });
    try {
      const base = join(scratch, "baseline.sqlite");
      await copyVerifiedCatalog(
        join(providerRoot, "artifacts", `${baseline.artifact.sha256}.sqlite`),
        base,
        baseline.artifact,
      );
      using source = new DatabaseSync(base, { readOnly: true });
      if (!matchesOpenFoodFactsDatabase(source, baseline)) {
        throw new Error("Open Food Facts baseline metadata does not match its manifest");
      }
      if (windows.length === 0) {
        const latest = await readCatalogManifestFile(join(providerRoot, "active.json"));
        if (!latest.equals(current)) throw new Error("Active catalog changed during delta check");
        return { status: "unchanged", cursor, manifest: baseline };
      }

      const downloads: Awaited<ReturnType<typeof download>>[] = [];
      for (const window of windows) downloads.push(await download(window, scratch, fetcher));
      const receipt = JSON.stringify({
        parent,
        from: cursor,
        through,
        deltas: downloads.map(({ url, sha256, bytes }) => ({ url, sha256, bytes })),
      });
      const receiptDigest = digest(receipt);
      const release = `off-delta-v1:${through}:${receiptDigest}`;
      const manifest = await publishCatalog(
        {
          root,
          provider,
          schemaVersion,
          importerVersion,
          expectedActiveSha256: parent,
          source: {
            url: deltaIndexUrl,
            release,
            lastModified: new Date(through * 1000).toISOString(),
          },
          attribution: openFoodFactsNotice,
          prepareInput: async (path) => {
            const receipts = join(providerRoot, "delta-sources");
            await mkdir(receipts, { recursive: true });
            if (!(await lstat(receipts)).isDirectory()) {
              throw new Error("Open Food Facts delta receipt path must be a real directory");
            }
            const receiptPath = join(receipts, `${receiptDigest}.json`);
            const stagedReceipt = join(scratch, "receipt.json");
            await writeFile(stagedReceipt, receipt, { flag: "wx", mode: 0o600, flush: true });
            try {
              await link(stagedReceipt, receiptPath);
            } catch (error) {
              if (
                !error ||
                typeof error !== "object" ||
                !("code" in error) ||
                error.code !== "EEXIST" ||
                (await readCatalogManifestFile(receiptPath)).toString("utf8") !== receipt
              )
                throw error;
            }
            if (process.platform !== "win32") {
              await using directory = await open(receipts, "r");
              await directory.sync();
            }
            await writeFile(path, receipt, { flag: "wx", mode: 0o600 });
          },
        },
        {
          async build(_receipt, destination) {
            // The verified private copy stays isolated from the previous immutable release.
            await copyVerifiedCatalog(base, destination, baseline.artifact);
            using database = new DatabaseSync(destination);
            database.exec("BEGIN");
            const counts = await applyWindows(database, downloads, release);
            database
              .prepare("UPDATE catalog_metadata SET release = ?, source_url = ?")
              .run(release, deltaIndexUrl);
            database.exec(`
              INSERT INTO food_search(food_search) VALUES ('rebuild');
              INSERT INTO food_search(food_search, rank) VALUES ('integrity-check', 1);
              COMMIT;
            `);
            return counts;
          },
          async validate(path, counts) {
            if (counts.accepted < Math.ceil(baseline.counts.accepted / 2)) {
              throw new Error("Open Food Facts deltas removed more than half of the catalog");
            }
            using database = new DatabaseSync(path, { readOnly: true });
            if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
              throw new Error("Open Food Facts delta catalog failed SQLite integrity verification");
            }
            validateOpenFoodFactsRows(database, counts.accepted);
          },
        },
      );
      return { status: "published", cursor: through, manifest };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

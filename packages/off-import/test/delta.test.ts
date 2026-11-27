import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { refreshOpenFoodFactsDeltas } from "../src/delta.ts";
import { publishOpenFoodFactsCatalog } from "../src/index.ts";
import { openFoodFactsCatalog, restoreOpenFoodFactsRelease } from "../src/publish.ts";

const first = 1_790_000_000;
const second = first + 86_400;
const third = second + 86_400;
const fourth = third + 86_400;
const now = new Date(fourth * 1000);
const provider = openFoodFactsCatalog.provider;

function product(code: string, name: string, modified: number, market = "en:germany") {
  return {
    _id: code,
    code,
    product_name_de: name,
    countries_tags: [market],
    last_modified_t: modified,
    rev: 1,
  };
}

function archive(rows: unknown[]) {
  return gzipSync(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

const deltaName = (from: number, to: number) => `openfoodfacts_products_${from}_${to}.json.gz`;

function feed(windows: [number, number, Buffer][]) {
  const index = windows.map(([from, through]) => deltaName(from, through)).join("\n");
  return (async (input) => {
    const url = new URL(String(input));
    if (url.href === openFoodFactsCatalog.deltaIndexUrl) return new Response(index);
    const window = windows.find(([from, to]) => url.pathname.endsWith(deltaName(from, to)));
    return window ? new Response(new Uint8Array(window[2])) : new Response("", { status: 404 });
  }) satisfies typeof fetch;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "edo-off-delta-test-"));
  const inputPath = join(root, "full.jsonl.gz");
  const before = [
    product("10000000", "Original", first),
    product("10000001", "Leaving Germany", first),
    product("10000002", "Untouched", first),
  ];
  await writeFile(inputPath, archive(before));
  await publishOpenFoodFactsCatalog({
    root,
    inputPath,
    release: "full-baseline",
    lastModified: new Date((first + 3600) * 1000).toISOString(),
  });
  return { root, activePath: join(root, provider, "active.json") };
}

test("applies all missed deltas in order, rebuilds search, and resumes at the committed checkpoint", async () => {
  const { root, activePath } = await setup();
  try {
    const fetcher = feed([
      [
        second,
        third,
        archive([
          product("10000000", "Latest", second + 300),
          product("10000003", "New", second + 300),
        ]),
      ],
      [
        first,
        second,
        archive([
          product("10000000", "Updated", first + 300),
          product("10000001", "Leaving Germany", first + 300, "en:france"),
        ]),
      ],
    ]);
    const result = await refreshOpenFoodFactsDeltas(root, { bootstrapFrom: first, fetcher, now });
    expect(result).toMatchObject({
      status: "published",
      cursor: third,
      manifest: {
        source: {
          url: openFoodFactsCatalog.deltaIndexUrl,
          lastModified: new Date(third * 1000).toISOString(),
        },
        counts: { accepted: 3, rejected: 0, skipped: 1 },
      },
    });
    const databasePath = join(
      root,
      provider,
      "artifacts",
      `${result.manifest.artifact.sha256}.sqlite`,
    );
    {
      using database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("SELECT name FROM food ORDER BY source_id").all()).toEqual([
        { name: "Latest" },
        { name: "Untouched" },
        { name: "New" },
      ]);
      expect(
        database
          .prepare("SELECT count(*) AS count FROM food_search WHERE food_search MATCH 'Latest'")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare("SELECT count(*) AS count FROM food_search WHERE food_search MATCH 'Original'")
          .get(),
      ).toEqual({ count: 0 });
    }
    const active = await readFile(activePath);
    const unchanged = await refreshOpenFoodFactsDeltas(root, { fetcher, now });
    expect(unchanged).toEqual({ ...result, status: "unchanged" });
    expect(await readFile(activePath)).toEqual(active);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing window or corrupt input leaves the preceding release and cursor active", async () => {
  const { root, activePath } = await setup();
  try {
    const initial = await readFile(activePath);
    await expect(
      refreshOpenFoodFactsDeltas(root, {
        bootstrapFrom: first,
        now,
        fetcher: feed([[second, third, archive([])]]),
      }),
    ).rejects.toThrow("missing or overlap");
    expect(await readFile(activePath)).toEqual(initial);
    await expect(
      refreshOpenFoodFactsDeltas(root, {
        bootstrapFrom: first,
        now,
        fetcher: feed([
          [first, second, archive([product("10000000", "Would change", first + 300)])],
          [second, third, archive([product("10000002", "Out of window", first + 300)])],
        ]),
      }),
    ).rejects.toThrow("ID or timestamp");
    expect(await readFile(activePath)).toEqual(initial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a concurrent restore wins over deltas based on the release it replaced", async () => {
  const { root, activePath } = await setup();
  try {
    const baseline = await readFile(activePath);
    const baselineSha256 = createHash("sha256").update(baseline).digest("hex");
    await refreshOpenFoodFactsDeltas(root, {
      bootstrapFrom: first,
      fetcher: feed([[first, second, archive([product("10000000", "Newer", first + 60)])]]),
      now,
    });
    const delta = createHash("sha256")
      .update(await readFile(activePath))
      .digest("hex");
    const next = feed([[second, third, archive([product("10000000", "Newest", second + 60)])]]);
    await expect(
      refreshOpenFoodFactsDeltas(root, {
        async fetcher(input) {
          if (String(input) !== openFoodFactsCatalog.deltaIndexUrl) {
            await restoreOpenFoodFactsRelease(root, baselineSha256);
          }
          return next(input);
        },
        now,
      }),
    ).rejects.toThrow("Active catalog changed before publication");
    expect(await readFile(activePath)).toEqual(baseline);
    await restoreOpenFoodFactsRelease(root, delta);
    const unchanged = feed([[first, second, archive([])]]);
    await expect(
      refreshOpenFoodFactsDeltas(root, {
        async fetcher(input) {
          await restoreOpenFoodFactsRelease(root, baselineSha256);
          return unchanged(input);
        },
        now,
      }),
    ).rejects.toThrow("Active catalog changed during delta check");
    expect(await readFile(activePath)).toEqual(baseline);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects old bootstrap windows, incomplete products, and invalid UTF-8 without activating them", async () => {
  const { root, activePath } = await setup();
  try {
    const initial = await readFile(activePath);
    const prior = first - 86_400;
    await expect(
      refreshOpenFoodFactsDeltas(root, {
        bootstrapFrom: prior,
        fetcher: feed([
          [prior, first, archive([product("10000003", "Deleted before full export", prior + 60)])],
          [first, second, archive([])],
        ]),
        now,
      }),
    ).rejects.toThrow("window adjacent");
    await expect(
      refreshOpenFoodFactsDeltas(root, {
        bootstrapFrom: first,
        fetcher: feed([
          [first, second, archive([{ _id: "10000000", last_modified_t: first + 60 }])],
        ]),
        now,
      }),
    ).rejects.toThrow("Incomplete Open Food Facts delta product");
    const changed = product("10000000", "Invalid", first + 60);
    await expect(
      refreshOpenFoodFactsDeltas(root, {
        bootstrapFrom: first,
        fetcher: feed([[first, second, archive([{ ...changed, product_name_de: {} }])]]),
        now,
      }),
    ).rejects.toThrow("Incomplete Open Food Facts delta product");
    await expect(
      refreshOpenFoodFactsDeltas(root, {
        bootstrapFrom: first,
        fetcher: feed([[first, second, archive([{ ...changed, _id: "\ud800" }])]]),
        now,
      }),
    ).rejects.toThrow("product ID or timestamp");
    const encoded = Buffer.from(JSON.stringify(product("10000000", "_", first + 60)));
    encoded[encoded.indexOf('"_",') + 1] = 0xff;
    await expect(
      refreshOpenFoodFactsDeltas(root, {
        bootstrapFrom: first,
        fetcher: feed([[first, second, gzipSync(encoded)]]),
        now,
      }),
    ).rejects.toThrow("encoded data");
    expect(await readFile(activePath)).toEqual(initial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

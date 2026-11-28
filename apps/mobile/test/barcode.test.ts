import { DatabaseSync } from "node:sqlite";
import { createDiaryItem, type PackagedFood } from "@edo/core";
import { openDiary, openPackagedFoodCache, type SqliteConnection } from "@edo/storage";
import { afterEach, expect, it, vi } from "vitest";
import {
  barcodeLookupOrder,
  expandUpcE,
  foodForPackagedProduct,
  lookupPackagedFood,
  retainedProducts,
  revalidatePackagedSelection,
  stalePackagedSelection,
} from "../src/barcode";
import { httpsOrigin } from "../src/catalog-origin";
import { saveFood } from "../src/diary-view";
import { foodKey, resolveFavoriteFoods } from "../src/favorite-foods";

const product: PackagedFood = {
  id: { provider: "open-food-facts", sourceId: "synthetic-juice" },
  name: "Carrot juice",
  alternateName: "Möhrensaft",
  barcode: "034000470693",
  release: "fixture-2026-11-26",
  preparation: "as-sold",
  nutrition: {
    basis: "per-100-ml",
    nutrients: { kcal: 41, proteinG: 0, availableCarbohydratesG: null, fatG: null, fiberG: null },
  },
};

function testConnection(db: DatabaseSync): SqliteConnection {
  return {
    exec: (sql) => db.exec(sql),
    run(sql, ...parameters) {
      db.prepare(sql).run(...parameters);
    },
    get: (sql, ...parameters) => db.prepare(sql).get(...parameters),
    all: (sql, ...parameters) => db.prepare(sql).all(...parameters),
  };
}

function jsonResponse(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps barcode candidates and explicit zeros, and resolves barcode, name and ID offline", async () => {
  using db = new DatabaseSync(":memory:");
  const connection = testConnection(db);
  const cache = openPackagedFoodCache(connection);
  const alternate = {
    ...product,
    id: { ...product.id, sourceId: "alternate" },
    barcode: "0034000470693",
    nutrition: null,
  };
  const call = vi.fn(async () =>
    jsonResponse({ status: "found", products: [product, alternate] }, 200),
  );
  vi.stubGlobal("fetch", call);
  const input = {
    code: ` ${product.barcode}\n`,
    cache,
    keep: () => [],
    now: () => 100,
    signal: new AbortController().signal,
  };
  const found = await lookupPackagedFood({ ...input, origin: "https://example.test" });
  expect(found).toEqual({ status: "found", products: [product, alternate], cached: false });
  expect(call).toHaveBeenCalledWith(
    `https://example.test/catalog-preview/open-food-facts/barcodes/${product.barcode}`,
    expect.objectContaining({ credentials: "omit", redirect: "error" }),
  );
  const reopened = openPackagedFoodCache(connection);
  const offline = await lookupPackagedFood({ ...input, origin: null, cache: reopened });
  expect(offline).toEqual({ status: "found", products: [product, alternate], cached: true });
  expect(call).toHaveBeenCalledTimes(1);
  expect(reopened.search("möhrensaft", 101)).toHaveLength(2);
  expect(
    reopened.findByIds([alternate.id.sourceId, "missing", alternate.id.sourceId], 101),
  ).toEqual([{ product: alternate, checkedAt: 100 }]);
  expect(foodForPackagedProduct(product).nutrition.nutrients.proteinG).toBe(0);
  expect(
    createDiaryItem("item", foodForPackagedProduct(alternate), { amount: 1, unit: "portion" })
      .nutrients.kcal,
  ).toBeNull();
});

it("uses an old local result if a recheck fails and preserves typed online misses", async () => {
  using db = new DatabaseSync(":memory:");
  const cache = openPackagedFoodCache(testConnection(db));
  cache.save([product], 0, []);
  const call = vi.fn(async () => jsonResponse({ status: "not-found" }, 404));
  vi.stubGlobal("fetch", call);
  const input = {
    origin: "https://example.test",
    cache,
    keep: () => [],
    now: () => 8 * 86400000,
    signal: new AbortController().signal,
  };
  await expect(lookupPackagedFood({ ...input, code: product.barcode })).resolves.toMatchObject({
    status: "found",
    cached: true,
  });
  await expect(lookupPackagedFood({ ...input, code: "44444444" })).resolves.toEqual({
    status: "not-found",
  });
  await expect(lookupPackagedFood({ ...input, code: "1234/5678" })).resolves.toEqual({
    status: "invalid",
  });
  expect(call).toHaveBeenCalledTimes(2);
});

it("rejects a response for a different barcode, broken origins and authorization-bearing URLs", async () => {
  expect(httpsOrigin("http://localhost:8787")).toBeNull();
  expect(httpsOrigin("https://someone:password@example.test")).toBeNull();
  expect(httpsOrigin("https://example.test/details")).toBeNull();
  expect(httpsOrigin("https://example.test/")).toBe("https://example.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ status: "found", products: [product] }, 200)),
  );
  const input = {
    code: "44444444",
    origin: "https://example.test",
    cache: null,
    keep: () => [],
    signal: new AbortController().signal,
  };
  await expect(lookupPackagedFood(input)).resolves.toEqual({ status: "unavailable" });
});

it("retains Open Food Facts favorites and products from the last 30 recorded diary days", () => {
  const item = createDiaryItem("item", foodForPackagedProduct(product), {
    amount: 100,
    unit: "ml",
  });
  const travelItem = {
    ...item,
    id: "east-of-date-line",
    food: { ...item.food, id: { ...product.id, sourceId: "recent-after-travel" } },
  };
  const diary = {
    listFavorites: () => [
      { ...product.id, sourceId: "favorite" },
      { provider: "bls" as const, sourceId: "bls-favorite" },
    ],
    listMeals: vi.fn((day: string) =>
      day === "2026-10-29" || day === "2026-11-29"
        ? [
            {
              id: "meal",
              localDay: day,
              occurredAt: 0,
              items: [day === "2026-11-29" ? travelItem : item],
            },
          ]
        : [],
    ),
  };
  expect(retainedProducts(diary, "2026-11-27")).toEqual([
    "favorite",
    travelItem.food.id.sourceId,
    product.id.sourceId,
  ]);
  expect(diary.listMeals).toHaveBeenCalledTimes(32);
});

it("keeps a favorite cached over budget and keeps a recent log after unpinning", async () => {
  using privateDb = new DatabaseSync(":memory:");
  using publicDb = new DatabaseSync(":memory:");
  const diary = await openDiary({
    connection: testConnection(privateDb),
    async backupBeforeMigration() {
      throw new Error("A blank diary needs no backup");
    },
  });
  const day = "2026-11-27";
  const cache = openPackagedFoodCache(testConnection(publicDb), 0);
  diary.setFavorite(product.id, true);
  cache.save([product], 10, retainedProducts(diary, day));
  const reopened = openPackagedFoodCache(testConnection(publicDb), 0);
  const found = await resolveFavoriteFoods({
    ids: diary.listFavorites(),
    localFoods: [],
    catalog: null,
    cache: reopened,
    language: "en",
    accessedAt: 11,
  });
  const food = found.byId.get(foodKey(product.id));
  if (!food) throw new Error("Expected to resolve the pinned food offline");
  const ids = ["item", "meal"].values();
  saveFood(
    diary,
    { kind: "add", food, day, occurredAt: Date.parse(`${day}T10:00:00Z`) },
    { amount: 100, unit: "ml" },
    () => ids.next().value ?? "",
  );
  diary.setFavorite(product.id, false);
  reopened.prune(retainedProducts(diary, day));
  expect(reopened.findByIds([product.id.sourceId], 12)).toHaveLength(1);
  reopened.prune(retainedProducts(diary, "2027-01-01"));
  expect(reopened.findByIds([product.id.sourceId], 13)).toEqual([]);
  expect(diary.listMeals(day)[0]?.items[0]?.nutrients.kcal).toBe(41);
});

it("keeps a known barcode available when a response is too large or has duplicate candidates", async () => {
  using db = new DatabaseSync(":memory:");
  const cache = openPackagedFoodCache(testConnection(db));
  cache.save([product], 0, []);
  const input = {
    code: product.barcode,
    origin: "https://example.test",
    cache,
    keep: () => [],
    now: () => 8 * 86400000,
    signal: new AbortController().signal,
  };
  const expected = { status: "found", products: [product], cached: true };
  const oversized = { ...product, name: "a".repeat(256 * 1024) };
  for (const products of [[oversized], [product, product]]) {
    const request = async () => jsonResponse({ status: "found", products }, 200);
    await expect(lookupPackagedFood({ ...input, request })).resolves.toEqual(expected);
  }
  const limited = async () => jsonResponse({ status: "rate-limited" }, 429);
  await expect(lookupPackagedFood({ ...input, request: limited })).resolves.toEqual(expected);
});

it("refreshes only the selected source and keeps both diary snapshots after cache eviction", async () => {
  using privateDb = new DatabaseSync(":memory:");
  using publicDb = new DatabaseSync(":memory:");
  const options = {
    connection: testConnection(privateDb),
    async backupBeforeMigration() {
      throw new Error("A blank or current diary needs no backup");
    },
  };
  const diary = await openDiary(options);
  const cache = openPackagedFoodCache(testConnection(publicDb), 0);
  const day = "2026-11-27";
  const prior = foodForPackagedProduct(product);
  const { id, barcode } = product;
  const latestNutrition = {
    basis: "per-100-g",
    nutrients: { kcal: 142, proteinG: 6, availableCarbohydratesG: 15, fatG: 1, fiberG: null },
  } as const;
  const current = { ...product, release: "fixture-2026-12-04", nutrition: latestNutrition };
  const sibling = { ...current, id: { ...id, sourceId: "same-code" }, name: "Different food" };
  const first = {
    kind: "add",
    food: prior,
    day,
    occurredAt: Date.parse(`${day}T09:00:00Z`),
  } as const;
  const ids = ["item-a", "meal-a", "item-b", "meal-b"].values();
  const nextId = () => ids.next().value ?? "";
  saveFood(diary, first, { amount: 100, unit: "ml" }, nextId);
  cache.save([product], 0, retainedProducts(diary, day));
  expect(stalePackagedSelection(prior, cache, 1)).toBeNull();

  const now = 8 * 86400000;
  // A complete lookup sees only a fresh sibling while the diary has retained the selected row.
  cache.saveBarcodeCandidates(barcode, [sibling], now, [id.sourceId, sibling.id.sourceId]);
  expect(cache.lookupBarcode(barcode, now)).toEqual([{ product: sibling, checkedAt: now }]);
  const selected = stalePackagedSelection(prior, cache, now);
  expect(selected).toEqual(product);
  if (!selected) throw new Error("Expected an older selected product");
  const request = vi.fn(async () =>
    jsonResponse({ status: "found", products: [sibling, current] }, 200),
  );
  const resolved = await revalidatePackagedSelection(selected, {
    origin: "https://example.test",
    cache,
    keep: () => retainedProducts(diary, day),
    now: () => now,
    request,
    signal: new AbortController().signal,
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(resolved).toEqual(foodForPackagedProduct(current));
  expect(stalePackagedSelection(prior, cache, now)).toBeNull();
  if (!resolved) throw new Error("Expected fresh nutrition for the selected source");
  saveFood(
    diary,
    { ...first, food: resolved, occurredAt: first.occurredAt + 3600000 },
    { amount: 50, unit: "g" },
    nextId,
  );

  cache.prune([]);
  expect(cache.findByIds([id.sourceId], now)).toEqual([]);
  const reopened = await openDiary(options);
  const items = reopened.listMeals(day).flatMap((meal) => meal.items);
  expect(items).toMatchObject([
    {
      food: { id, release: product.release, nutrition: { basis: "per-100-ml" } },
      portion: { amount: 100, unit: "ml" },
      nutrients: { kcal: 41 },
    },
    {
      food: { id, release: current.release, nutrition: { basis: "per-100-g" } },
      portion: { amount: 50, unit: "g" },
      nutrients: { kcal: 71 },
    },
  ]);
});

it("keeps the selected local product when the refresh is unavailable, missing or canceled", async () => {
  using db = new DatabaseSync(":memory:");
  const cache = openPackagedFoodCache(testConnection(db));
  cache.save([product], 0, []);
  const now = 8 * 86400000;
  const controller = new AbortController();
  const options = {
    origin: "https://example.test",
    cache,
    keep: () => [],
    now: () => now,
    signal: controller.signal,
  };
  const sibling = { ...product, id: { ...product.id, sourceId: "sibling" } };
  expect(
    await revalidatePackagedSelection(product, {
      ...options,
      request: async () => {
        throw new Error("Offline");
      },
    }),
  ).toBeNull();
  expect(
    await revalidatePackagedSelection(product, {
      ...options,
      request: async () => jsonResponse({ status: "found", products: [sibling] }, 200),
    }),
  ).toBeNull();
  expect(
    await revalidatePackagedSelection(product, {
      ...options,
      request: async () => {
        controller.abort();
        return jsonResponse({ status: "found", products: [{ ...product, name: "Updated" }] }, 200);
      },
    }),
  ).toBeNull();
  expect(cache.findByIds([product.id.sourceId], now)).toEqual([{ product, checkedAt: 0 }]);
});

it("replaces offline scan candidates only for a complete catalog response", async () => {
  using db = new DatabaseSync(":memory:");
  const adapter = testConnection(db);
  const retired = { ...product, id: { ...product.id, sourceId: "retired" }, name: "Retired juice" };
  const cache = openPackagedFoodCache(adapter);
  cache.save([retired], 0, []);
  const input = {
    code: retired.barcode,
    origin: "https://example.test",
    cache,
    keep: () => [retired.id.sourceId],
    now: () => 8 * 86400000,
    signal: new AbortController().signal,
  };
  const catalog = async () =>
    jsonResponse(
      {
        status: "found",
        source: "catalog",
        releaseManifestSha256: "a".repeat(64),
        products: [product],
      },
      200,
    );
  await lookupPackagedFood({ ...input, request: catalog });
  const reopened = openPackagedFoodCache(adapter);
  await expect(lookupPackagedFood({ ...input, cache: reopened, origin: null })).resolves.toEqual({
    status: "found",
    products: [product],
    cached: true,
  });
  expect(reopened.search("retired", input.now())).toEqual([{ product: retired, checkedAt: 0 }]);
});

it("stops a timed-out lookup and leaves the cached candidate available", async () => {
  vi.useFakeTimers();
  using db = new DatabaseSync(":memory:");
  const cache = openPackagedFoodCache(testConnection(db));
  cache.save([product], 0, []);
  const request = vi.fn<typeof fetch>(
    (_, init) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      ),
  );
  const lookup = lookupPackagedFood({
    code: product.barcode,
    origin: "https://example.test",
    cache,
    keep: () => [],
    now: () => 8 * 86400000,
    signal: new AbortController().signal,
    request,
  });
  await vi.advanceTimersByTimeAsync(5000);
  await expect(lookup).resolves.toEqual({ status: "found", products: [product], cached: true });
  expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it("saves a selected barcode portion with the captured day, offset, and nutrient snapshot", async () => {
  using privateDb = new DatabaseSync(":memory:");
  const open = () =>
    openDiary({
      connection: testConnection(privateDb),
      async backupBeforeMigration() {
        throw new Error("A blank test diary needs no backup");
      },
    });
  const diary = await open();
  const entry = {
    kind: "add" as const,
    food: foodForPackagedProduct(product),
    day: "2026-11-27",
    occurredAt: Date.parse("2026-11-28T04:30:00Z"),
    utcOffsetMinutes: -300,
  };
  const ids = ["meal", "item"].values();
  const portion = { amount: 250, unit: "ml" } as const;
  saveFood(diary, entry, portion, () => ids.next().value ?? "");
  const reopened = await open();
  expect(reopened.listMeals(entry.day)).toMatchObject([
    {
      localDay: entry.day,
      occurredAt: entry.occurredAt,
      utcOffsetMinutes: -300,
      items: [
        {
          food: { id: product.id, release: product.release },
          portion,
          nutrients: { kcal: 102.5, proteinG: 0, availableCarbohydratesG: null },
        },
      ],
    },
  ]);
});

// GS1 General Specifications 26.0, figures 5-15 through 5-18.
it.each([
  ["01234558", "012345000058"],
  ["04567840", "045670000080"],
  ["03456703", "034000005673"],
  ["09847531", "098400000751"],
  ["01234559", null],
  ["12345678", null],
])("expands a camera-identified UPC-E %s", (code, expected) => {
  expect(expandUpcE(code)).toBe(expected);
});

it("falls back to a cached UPC-E product that was previously entered verbatim", async () => {
  using db = new DatabaseSync(":memory:");
  const cache = openPackagedFoodCache(testConnection(db));
  const literal = { ...product, barcode: "01234558" };
  cache.save([literal], 10, []);
  await expect(
    lookupPackagedFood({
      ...barcodeLookupOrder(literal.barcode, true),
      cache,
      keep: () => [],
      origin: null,
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ status: "found", products: [literal], cached: true });
});

it("uses the printed code first for manual entry and finds an expanded UPC-E online or offline", async () => {
  using db = new DatabaseSync(":memory:");
  const cache = openPackagedFoodCache(testConnection(db));
  const printed = "01234558";
  const expanded = { ...product, barcode: "012345000058" };
  const request = vi.fn(async (url: string) =>
    url.endsWith(expanded.barcode)
      ? jsonResponse({ status: "found", products: [expanded] }, 200)
      : jsonResponse({ status: "not-found" }, 404),
  );
  const lookup = {
    ...barcodeLookupOrder(printed, false),
    cache,
    keep: () => [],
    signal: new AbortController().signal,
    request,
  };
  await expect(lookupPackagedFood({ ...lookup, origin: "https://example.test" })).resolves.toEqual({
    status: "found",
    products: [expanded],
    cached: false,
  });
  expect(request.mock.calls.map(([url]) => url.split("/").at(-1))).toEqual([
    printed,
    expanded.barcode,
  ]);
  await expect(lookupPackagedFood({ ...lookup, origin: null })).resolves.toEqual({
    status: "found",
    products: [expanded],
    cached: true,
  });
  const direct = { ...product, id: { ...product.id, sourceId: "ean-8" }, barcode: printed };
  cache.save([direct], Date.now(), []);
  await expect(lookupPackagedFood({ ...lookup, origin: null })).resolves.toEqual({
    status: "found",
    products: [direct],
    cached: true,
  });
});

it("reports that an expanded-code lookup is rate-limited after a printed-code miss", async () => {
  const printed = "01234558";
  const request = async (url: string) =>
    url.endsWith(printed)
      ? jsonResponse({ status: "not-found" }, 404)
      : jsonResponse({ status: "rate-limited" }, 429);
  await expect(
    lookupPackagedFood({
      ...barcodeLookupOrder(printed, false),
      origin: "https://example.test",
      cache: null,
      keep: () => [],
      signal: new AbortController().signal,
      request,
    }),
  ).resolves.toEqual({ status: "rate-limited" });
});

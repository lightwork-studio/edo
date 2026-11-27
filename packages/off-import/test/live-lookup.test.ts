import { expect, it, vi } from "vitest";
import { createOpenFoodFactsLiveLookup } from "../src/index.ts";

const start = Date.parse("2026-11-27T04:00:00Z");
const product = {
  _id: "original-off-id",
  code: "0034000470693",
  product_name_en: "Oat drink",
  last_modified_t: 1_700_000_000,
  nutrition: {
    aggregated_set: {
      per: "100ml",
      preparation: "as_sold",
      nutrients: { fat: { value: 0, unit: "g" } },
    },
  },
};

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

it("identifies the client, coalesces barcode aliases and keeps the exact returned product", async () => {
  const fetchProduct = vi.fn<typeof fetch>(async () =>
    Response.json({
      code: product.code,
      status: "success",
      result: { id: "product_found" },
      product,
    }),
  );
  const lookup = createOpenFoodFactsLiveLookup(fetchProduct, () => start);
  const results = await Promise.all([
    lookup(`${"0".repeat(10_000)}34000470693`),
    lookup("034000470693"),
  ]);
  expect(fetchProduct).toHaveBeenCalledTimes(1);
  const [target, options] = fetchProduct.mock.calls[0] ?? [];
  const request = new URL(String(target));
  expect(request.origin).toBe("https://world.openfoodfacts.org");
  expect(request.pathname).toBe("/api/v3.6/product/0034000470693");
  expect(request.searchParams.get("product_type")).toBe("food");
  expect(request.searchParams.get("fields")?.split(",")).toContain("nutrition");
  expect(new Headers(options?.headers).get("user-agent")).toContain("lightwork-studio/edo");
  expect(options?.redirect).toBe("error");
  expect(results[0]).toMatchObject({
    status: "found",
    checkedAt: start,
    product: {
      id: { provider: "open-food-facts", sourceId: "original-off-id" },
      barcode: product.code,
      name: "Oat drink",
      release: "live-revision:1700000000",
      nutrition: { basis: "per-100-ml", nutrients: { kcal: null, fatG: 0 } },
    },
  });
  expect(results[1]).toEqual(results[0]);
  await expect(lookup("not-a-product")).resolves.toEqual({ status: "invalid" });
  expect(fetchProduct).toHaveBeenCalledTimes(1);
});

it("sanitizes the nutrition of a live product with a measured gram serving", async () => {
  const fetchProduct: typeof fetch = async () =>
    Response.json({
      result: { id: "product_found" },
      product: {
        ...product,
        serving_quantity: 4,
        serving_quantity_unit: "g",
        nutrition: {
          aggregated_set: {
            per: "serving",
            preparation: "as_sold",
            nutrients: {
              "energy-kcal": { value: 400, unit: "kcal" },
              fat: { value: 0, unit: "g" },
            },
          },
        },
      },
    });
  const lookup = createOpenFoodFactsLiveLookup(fetchProduct, () => start);
  await expect(lookup(product.code)).resolves.toMatchObject({
    status: "found",
    product: {
      nutrition: {
        basis: "per-portion",
        portionSize: { amount: 4, unit: "g" },
        nutrients: { kcal: null, fatG: 0 },
      },
    },
  });
});

it("limits requests in a rolling window and honors the upstream retry delay", async () => {
  let time = start;
  const fetchProduct = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
  const lookup = createOpenFoodFactsLiveLookup(fetchProduct, () => time);
  for (let index = 0; index < 10; index += 1) {
    await expect(lookup(String(19000000 + index))).resolves.toEqual({ status: "not-found" });
  }
  await expect(lookup("19000011")).resolves.toEqual({ status: "rate-limited" });
  expect(fetchProduct).toHaveBeenCalledTimes(10);
  time += 60_000;
  fetchProduct.mockResolvedValueOnce(
    new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
  );
  await expect(lookup("19000011")).resolves.toEqual({ status: "rate-limited" });
  time += 119_999;
  await expect(lookup("19000012")).resolves.toEqual({ status: "rate-limited" });
  expect(fetchProduct).toHaveBeenCalledTimes(11);
  time += 1;
  await expect(lookup("19000012")).resolves.toEqual({ status: "not-found" });
  expect(fetchProduct).toHaveBeenCalledTimes(12);
});

it("treats a mismatched response, invalid payload or upstream failure as unavailable", async () => {
  const fetchProduct = vi.fn<typeof fetch>(async () => Response.json({ product }));
  const lookup = createOpenFoodFactsLiveLookup(fetchProduct, () => start);
  await expect(lookup("19000001")).resolves.toEqual({ status: "unavailable" });
  fetchProduct.mockResolvedValueOnce(Response.json({ result: "unexpected" }));
  await expect(lookup("034000470693")).resolves.toEqual({ status: "unavailable" });
  fetchProduct.mockRejectedValueOnce(new Error("Network unavailable"));
  await expect(lookup("034000470693")).resolves.toEqual({ status: "unavailable" });
});

it("pauses other lookups when the rate-limit headers arrive", async () => {
  const started = deferred();
  const finished = deferred();
  const body = new ReadableStream({
    cancel() {
      started.resolve();
      return finished.promise;
    },
  });
  const fetchProduct = vi.fn<typeof fetch>(async () => new Response(body, { status: 429 }));
  const lookup = createOpenFoodFactsLiveLookup(fetchProduct, () => start);
  const first = lookup("19000001");
  await started.promise;
  try {
    await expect(lookup("19000002")).resolves.toEqual({ status: "rate-limited" });
    expect(fetchProduct).toHaveBeenCalledTimes(1);
  } finally {
    finished.resolve();
  }
  await expect(first).resolves.toEqual({ status: "rate-limited" });
});

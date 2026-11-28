import { type CatalogDatabase, findBlsFoods } from "@edo/catalog-import/bls-search";
import type { Food, FoodId } from "@edo/core";
import type { PackagedFoodCache } from "@edo/storage";
import { foodForPackagedProduct } from "./barcode";
import type { Language } from "./strings";

export function foodKey(id: FoodId): string {
  return `${id.provider}:${id.sourceId}`;
}

export async function resolveFavoriteFoods({
  ids,
  localFoods,
  catalog,
  cache,
  language,
  accessedAt,
}: {
  ids: readonly FoodId[];
  localFoods: readonly Food[];
  catalog: CatalogDatabase | null;
  cache: Pick<PackagedFoodCache, "findByIds"> | null;
  language: Language;
  accessedAt: number;
}): Promise<{ byId: ReadonlyMap<string, Food>; failedProviders: ReadonlySet<FoodId["provider"]> }> {
  const byId = new Map(localFoods.map((food) => [foodKey(food.id), food]));
  const failedProviders = new Set<FoodId["provider"]>();
  const offIds = ids
    .filter(({ provider }) => provider === "open-food-facts")
    .map(({ sourceId }) => sourceId);
  try {
    const cached = offIds.length ? cache?.findByIds(offIds, accessedAt) : undefined;
    for (const { product } of cached ?? []) {
      const food = foodForPackagedProduct(product);
      byId.set(foodKey(food.id), food);
    }
  } catch {
    failedProviders.add("open-food-facts");
  }
  if (catalog) {
    const blsIds = ids.filter(({ provider }) => provider === "bls").map(({ sourceId }) => sourceId);
    try {
      for (const food of await findBlsFoods(catalog, blsIds, language)) {
        byId.set(foodKey(food.id), food);
      }
    } catch {
      failedProviders.add("bls");
    }
  }
  return { byId, failedProviders };
}

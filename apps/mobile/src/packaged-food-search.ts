import type { Food } from "@edo/core";
import type { PackagedFoodCache } from "@edo/storage";
import { foodForPackagedProduct } from "./barcode";

export function searchCachedPackagedFoods(
  cache: Pick<PackagedFoodCache, "search"> | null,
  query: string,
  accessedAt = Date.now(),
): Food[] {
  try {
    return (
      cache?.search(query, accessedAt).map(({ product }) => foodForPackagedProduct(product)) ?? []
    );
  } catch {
    return [];
  }
}

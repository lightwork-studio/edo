import { type CatalogDatabase, findBlsFoods } from "@edo/catalog-import/bls-search";
import type { Food, FoodId } from "@edo/core";
import type { DiaryStore, PackagedFoodCache } from "@edo/storage";
import { foodForPackagedProduct, recentPackagedDays } from "./barcode";
import type { Language } from "./strings";

export function foodKey(id: FoodId): string {
  return `${id.provider}:${id.sourceId}`;
}

type RecentDiary = { diary: Pick<DiaryStore, "listMeals">; today: string };

function addRecentPackagedFavorites(
  { diary, today }: RecentDiary,
  sourceIds: readonly string[],
  byId: Map<string, Food>,
  fromDiary: Set<string>,
): boolean {
  const missing = new Set(
    sourceIds.filter((id) => !byId.has(foodKey({ provider: "open-food-facts", sourceId: id }))),
  );
  let unreadableDay = false;
  for (const day of recentPackagedDays(today)) {
    if (!missing.size) break;
    try {
      const latest = new Map<string, { food: Food; occurredAt: number }>();
      for (const { items, occurredAt } of diary.listMeals(day)) {
        for (const { food } of items) {
          const { provider, sourceId } = food.id;
          if (provider !== "open-food-facts" || !missing.has(sourceId)) continue;
          const previous = latest.get(sourceId);
          if (!previous || occurredAt > previous.occurredAt)
            latest.set(sourceId, { food, occurredAt });
        }
      }
      for (const [sourceId, { food }] of latest) {
        const key = foodKey(food.id);
        byId.set(key, food);
        fromDiary.add(key);
        missing.delete(sourceId);
      }
    } catch {
      unreadableDay = true;
    }
  }
  return unreadableDay && missing.size > 0;
}

export async function resolveFavoriteFoods({
  ids,
  localFoods,
  catalog,
  cache,
  language,
  accessedAt,
  recentDiary,
}: {
  ids: readonly FoodId[];
  localFoods: readonly Food[];
  catalog: CatalogDatabase | null;
  cache: Pick<PackagedFoodCache, "findByIds"> | null;
  language: Language;
  accessedAt: number;
  recentDiary?: RecentDiary;
}): Promise<{
  byId: ReadonlyMap<string, Food>;
  fromDiary: ReadonlySet<string>;
  failedProviders: ReadonlySet<FoodId["provider"]>;
}> {
  const byId = new Map(localFoods.map((food) => [foodKey(food.id), food]));
  const fromDiary = new Set<string>();
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
  if (recentDiary && addRecentPackagedFavorites(recentDiary, offIds, byId, fromDiary)) {
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
  return { byId, fromDiary, failedProviders };
}

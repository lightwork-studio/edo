import type { CatalogDatabase } from "@edo/catalog-import/bls-search";
import type { Food, FoodId } from "@edo/core";
import type { DiaryStore, PackagedFoodCache } from "@edo/storage";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { foodKey, resolveFavoriteFoods } from "./favorite-foods";
import type { Language, Strings } from "./strings";
import { Notice, styles } from "./ui";

export function FavoriteFoodList({
  t,
  ids,
  localFoods,
  recipeFoods,
  catalog,
  cache,
  diary,
  today,
  language,
  match,
  onPick,
  onRemove,
  onRetry,
}: {
  t: Strings;
  ids: readonly FoodId[];
  localFoods: readonly Food[] | null;
  recipeFoods: readonly Food[] | null;
  catalog: CatalogDatabase | "error" | null;
  cache: PackagedFoodCache | "error" | null;
  diary: Pick<DiaryStore, "listMeals">;
  today: string;
  language: Language;
  match?: (name: string) => boolean;
  onPick: (food: Food) => void;
  onRemove: (id: FoodId) => void;
  onRetry: (provider: FoodId["provider"]) => void;
}) {
  const [error, setError] = useState(false);
  const [result, setResult] = useState<{
    ids: readonly FoodId[];
    localFoods: readonly Food[] | null;
    recipeFoods: readonly Food[] | null;
    catalog: CatalogDatabase | "error" | null;
    cache: PackagedFoodCache | "error" | null;
    diary: Pick<DiaryStore, "listMeals">;
    today: string;
    language: Language;
    resolved: Awaited<ReturnType<typeof resolveFavoriteFoods>>;
  } | null>(null);
  useEffect(() => {
    if (!ids.length) return;
    let active = true;
    void resolveFavoriteFoods({
      ids,
      localFoods: [...(localFoods ?? []), ...(recipeFoods ?? [])],
      catalog: catalog === "error" ? null : catalog,
      cache: cache === "error" ? null : cache,
      language,
      accessedAt: Date.now(),
      recentDiary: { diary, today },
    }).then((resolved) => {
      if (active)
        setResult({
          ids,
          localFoods,
          recipeFoods,
          catalog,
          cache,
          diary,
          today,
          language,
          resolved,
        });
    });
    return () => {
      active = false;
    };
  }, [ids, localFoods, recipeFoods, catalog, cache, diary, today, language]);

  if (!ids.length) return null;
  const ready =
    result?.ids === ids &&
    result.localFoods === localFoods &&
    result.recipeFoods === recipeFoods &&
    result.catalog === catalog &&
    result.cache === cache &&
    result.diary === diary &&
    result.today === today &&
    result.language === language;
  const showCacheRetry =
    ready &&
    (cache === "error" || result.resolved.packagedCacheFailed) &&
    result.resolved.fromDiary.size > 0 &&
    ids.every((id) => id.provider !== "open-food-facts" || result.resolved.byId.has(foodKey(id)));
  const listed =
    ready && match
      ? ids.filter((id) => {
          const food = result.resolved.byId.get(foodKey(id));
          return !food || match(food.name);
        })
      : ids;
  return (
    <>
      <Text accessibilityRole="header" style={styles.title}>
        {t.favorites}
      </Text>
      {!ready && <Notice text={t.loading} pending />}
      {ready && listed.length === 0 && <Notice text={t.libraryNoMatches} />}
      {showCacheRetry && (
        <Notice
          text={t.favoriteCacheUnavailable}
          action={{ label: t.retry, onPress: () => onRetry("open-food-facts") }}
        />
      )}
      {ready &&
        listed.map((id) => {
          const key = foodKey(id);
          const food = result.resolved.byId.get(key);
          const source =
            id.provider === "bls" ? catalog : id.provider === "open-food-facts" ? cache : undefined;
          if (!food && source === null) {
            return <Notice key={key} text={t.loading} pending />;
          }
          const localSource = id.sourceId.startsWith("recipe:") ? recipeFoods : localFoods;
          if (
            !food &&
            (source === "error" ||
              result.resolved.failedProviders.has(id.provider) ||
              (id.provider === "local" && localSource === null))
          ) {
            return (
              <Notice
                key={key}
                text={t.favoriteReadError(id.sourceId)}
                action={{ label: t.retry, onPress: () => onRetry(id.provider) }}
              />
            );
          }
          const name = food?.name ?? t.unavailableFavorite(id.sourceId);
          return (
            <View key={key} style={[styles.card, styles.row]}>
              {food ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityHint={t.addFood}
                  style={[
                    styles.action,
                    styles.stretch,
                    { alignItems: "flex-start", paddingHorizontal: 0 },
                  ]}
                  onPress={() => onPick(food)}
                >
                  <Text style={styles.title}>{name}</Text>
                  {result.resolved.fromDiary.has(key) && (
                    <Text style={styles.meta}>{t.favoriteFromDiary}</Text>
                  )}
                </Pressable>
              ) : (
                <Text style={[styles.meta, styles.stretch]}>{name}</Text>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.removeFavorite(name)}
                onPress={() => {
                  try {
                    onRemove(id);
                    setError(false);
                  } catch {
                    setError(true);
                  }
                }}
                style={[styles.action, { minWidth: 44 }]}
              >
                <Text style={styles.actionText}>★</Text>
              </Pressable>
            </View>
          );
        })}
      {error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {t.favoriteError}
        </Text>
      )}
    </>
  );
}

import type { Food, FoodId } from "@edo/core";
import type { PackagedFoodCache } from "@edo/storage";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { CatalogDatabase } from "./catalog";
import { foodKey, resolveFavoriteFoods } from "./favorite-foods";
import type { Language, Strings } from "./strings";
import { Notice, styles } from "./ui";

export function FavoriteFoodList({
  t,
  ids,
  localFoods,
  catalog,
  cache,
  language,
  onPick,
  onRemove,
}: {
  t: Strings;
  ids: readonly FoodId[];
  localFoods: readonly Food[];
  catalog: CatalogDatabase | null;
  cache: PackagedFoodCache | null;
  language: Language;
  onPick: (food: Food) => void;
  onRemove: (id: FoodId) => void;
}) {
  const [error, setError] = useState(false);
  const [result, setResult] = useState<{
    ids: readonly FoodId[];
    localFoods: readonly Food[];
    catalog: CatalogDatabase | null;
    cache: PackagedFoodCache | null;
    language: Language;
    byId: ReadonlyMap<string, Food>;
  } | null>(null);
  useEffect(() => {
    if (!ids.length) return;
    let active = true;
    void resolveFavoriteFoods({
      ids,
      localFoods,
      catalog,
      cache,
      language,
      accessedAt: Date.now(),
    }).then((byId) => {
      if (active) setResult({ ids, localFoods, catalog, cache, language, byId });
    });
    return () => {
      active = false;
    };
  }, [ids, localFoods, catalog, cache, language]);

  if (!ids.length) return null;
  const ready =
    result?.ids === ids &&
    result.localFoods === localFoods &&
    result.catalog === catalog &&
    result.cache === cache &&
    result.language === language;
  return (
    <>
      <Text accessibilityRole="header" style={styles.title}>
        {t.favorites}
      </Text>
      {!ready && <Notice text={t.loading} pending />}
      {ready &&
        ids.map((id) => {
          const key = foodKey(id);
          const food = result.byId.get(key);
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
                style={styles.action}
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

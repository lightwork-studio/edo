import { type Food, roundNutritionForDisplay } from "@edo/core";
import type { PackagedFoodCache } from "@edo/storage";
import type { SQLiteDatabase } from "expo-sqlite";
import { useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { openFoodFactsLicenseUrl } from "./barcode";
import { searchBls } from "./catalog";
import { SourceLink } from "./catalog-source-link";
import { searchCachedPackagedFoods } from "./packaged-food-search";
import type { Language, Strings } from "./strings";
import { colors, DetailHeader, Notice, nutrientValue, styles } from "./ui";

export function SearchScreen({
  t,
  locale,
  language,
  date,
  catalog,
  query,
  onQuery,
  packagedCache,
  onBarcode,
  onMyFoods,
  onCatalogRetry,
  onPick,
  onBack,
}: {
  t: Strings;
  locale: string;
  language: Language;
  date: string;
  catalog: SQLiteDatabase | "error" | null;
  query: string;
  onQuery: (query: string) => void;
  packagedCache: PackagedFoodCache | null;
  onBarcode: () => void;
  onMyFoods: () => void;
  onCatalogRetry: () => void;
  onPick: (food: Food) => void;
  onBack: () => void;
}) {
  const [credit, setCredit] = useState(false);

  return (
    <>
      <DetailHeader title={t.addFood} subtitle={date} back={t.back} onBack={onBack} />
      <View style={local.controls}>
        <TextInput
          accessibilityLabel={t.search}
          placeholder={t.searchPlaceholder}
          placeholderTextColor={colors.muted}
          value={query}
          onChangeText={onQuery}
          maxLength={120}
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={local.search}
        />
        <View style={[styles.row, local.actions]}>
          <Pressable accessibilityRole="button" style={local.source} onPress={onBarcode}>
            <Text style={styles.actionText}>{t.scanBarcode}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" style={local.source} onPress={onMyFoods}>
            <Text style={styles.actionText}>{t.myFoods}</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={credit ? t.closeSource : t.source}
            accessibilityRole="button"
            accessibilityState={{ expanded: credit }}
            onPress={() => setCredit(!credit)}
            style={local.source}
          >
            <Text style={styles.actionText}>{t.source}</Text>
          </Pressable>
        </View>
        {credit && (
          <View style={styles.card}>
            <Text style={styles.body}>{t.credit}</Text>
            <Text style={styles.meta}>{t.creditChanges}</Text>
            <SourceLink
              uri="https://doi.org/10.25826/Data20251217-134202-0"
              title="DOI 10.25826/Data20251217-134202-0"
            />
            <SourceLink uri="https://creativecommons.org/licenses/by/4.0/" title="CC BY 4.0" />
            {packagedCache && (
              <>
                <Text style={styles.body}>{t.openFoodFactsCredit}</Text>
                <SourceLink uri={openFoodFactsLicenseUrl} title={t.openFoodFactsLicense} />
              </>
            )}
          </View>
        )}
      </View>
      {catalog === null && <Notice text={t.loading} pending />}
      {catalog === "error" && (
        <Notice text={t.catalogError} action={{ label: t.retry, onPress: onCatalogRetry }} />
      )}
      {((catalog && catalog !== "error") || packagedCache) && (
        <Results
          db={catalog === "error" ? null : catalog}
          packagedCache={packagedCache}
          t={t}
          locale={locale}
          language={language}
          query={query.trim()}
          onPick={onPick}
        />
      )}
    </>
  );
}

const nutritionBasis = {
  "per-100-g": "per100g",
  "per-100-ml": "per100ml",
  "per-portion": "perPortion",
} as const;

function Results({
  db,
  packagedCache,
  t,
  locale,
  language,
  query,
  onPick,
}: {
  db: SQLiteDatabase | null;
  packagedCache: PackagedFoodCache | null;
  t: Strings;
  locale: string;
  language: Language;
  query: string;
  onPick: (food: Food) => void;
}) {
  const [result, setResult] = useState<{
    query: string;
    language: Language;
    attempt: number;
    foods: Food[];
    usedCache: PackagedFoodCache | null;
    usedBls: SQLiteDatabase | null;
    blsFailure: boolean;
  }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!query) return;
    let current = true;
    const timer = setTimeout(() => {
      const cached = searchCachedPackagedFoods(packagedCache, query);
      const bls = db ? searchBls(db, query, language).catch(() => null) : Promise.resolve([]);
      void bls.then((foods) => {
        if (!current) return;
        setResult({
          query,
          language,
          attempt,
          foods: [...(foods ?? []), ...cached],
          usedCache: packagedCache,
          usedBls: db,
          blsFailure: foods === null,
        });
      });
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [db, packagedCache, query, language, attempt]);

  if (!query) return null;
  if (
    result?.query !== query ||
    result.language !== language ||
    result.attempt !== attempt ||
    result.usedBls !== db ||
    result.usedCache !== packagedCache
  )
    return <Notice text={t.loading} pending />;
  if (result.blsFailure && !result.foods.length) {
    return (
      <Notice
        text={t.searchError}
        action={{ label: t.retry, onPress: () => setAttempt((attempt) => attempt + 1) }}
      />
    );
  }
  return (
    <FlatList
      data={result.foods}
      keyExtractor={(food) => `${food.id.provider}:${food.id.sourceId}`}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={local.results}
      ListEmptyComponent={<Notice text={t.noResults} />}
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() => onPick(item)}
          style={({ pressed }) => [
            styles.card,
            styles.row,
            local.result,
            pressed && styles.pressed,
          ]}
        >
          <View style={styles.stretch}>
            <Text style={local.name}>{item.name}</Text>
            {item.id.provider === "open-food-facts" && (
              <Text style={styles.meta}>{t.openFoodFactsCredit}</Text>
            )}
            <Text style={styles.meta}>
              {item.nutrition.nutrients.kcal === null
                ? t.unavailable
                : `${nutrientValue(roundNutritionForDisplay(item.nutrition.nutrients).kcal, locale, "kcal")} · ${t[nutritionBasis[item.nutrition.basis]]}`}
            </Text>
          </View>
          <View importantForAccessibility="no" style={local.pick}>
            <Text style={local.plus}>+</Text>
          </View>
        </Pressable>
      )}
    />
  );
}

const local = StyleSheet.create({
  controls: { paddingHorizontal: 16, paddingTop: 12, gap: 8 },
  actions: { flexWrap: "wrap", gap: 8 },
  search: {
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.field,
    color: colors.text,
    fontSize: 16,
    borderRadius: 16,
  },
  source: {
    minHeight: 44,
    alignSelf: "flex-start",
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: 22,
    backgroundColor: colors.accentSoft,
  },
  results: { padding: 16, gap: 8 },
  result: { paddingVertical: 12 },
  name: { color: colors.text, fontSize: 16, fontWeight: "600", marginBottom: 4 },
  pick: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  plus: { color: colors.accent, fontSize: 21, lineHeight: 24 },
});

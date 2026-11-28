import { searchBls } from "@edo/catalog-import/bls-search";
import { type Food, roundNutritionForDisplay } from "@edo/core";
import type { PackagedFoodCache } from "@edo/storage";
import type { SQLiteDatabase } from "expo-sqlite";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { openFoodFactsLicenseUrl } from "./barcode";
import { SourceLink } from "./catalog-source-link";
import { searchCachedPackagedFoods } from "./packaged-food-search";
import type { Language, Strings } from "./strings";
import { colors, displayNumber, fontFace, IconButton, Notice, styles } from "./ui";

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
  const [focused, setFocused] = useState(false);
  const searchInput = useRef<ComponentRef<typeof TextInput>>(null);

  return (
    <>
      <View style={styles.header}>
        <IconButton label={t.back} glyph="×" onPress={onBack} />
        <View style={local.title}>
          <Text accessibilityRole="header" style={styles.title}>
            {t.addFood}
          </Text>
          <Text style={styles.meta}>{date}</Text>
        </View>
        <View style={local.headerSpacer} />
      </View>
      <View style={local.controls}>
        <View style={local.searchRow}>
          <View style={[local.searchField, focused && local.searchFocused]}>
            <View style={local.lens} importantForAccessibility="no">
              <View style={local.lensCircle} />
              <View style={local.lensHandle} />
            </View>
            <TextInput
              ref={searchInput}
              accessibilityLabel={t.search}
              placeholder={t.searchPlaceholder}
              placeholderTextColor={colors.muted}
              value={query}
              onChangeText={onQuery}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              maxLength={120}
              autoCorrect={false}
              returnKeyType="search"
              style={local.search}
            />
            {query !== "" && (
              <Pressable
                accessibilityLabel={t.clearSearch}
                accessibilityRole="button"
                onPress={() => {
                  onQuery("");
                  searchInput.current?.focus();
                }}
                style={local.clear}
              >
                <Text style={local.clearText}>×</Text>
              </Pressable>
            )}
          </View>
          <Pressable
            accessibilityLabel={t.scanBarcode}
            accessibilityRole="button"
            style={styles.iconButton}
            onPress={onBarcode}
          >
            <View
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
              style={local.barcode}
            >
              <View style={local.barcodeBar} />
              <View style={local.barcodeBarWide} />
              <View style={local.barcodeBar} />
              <View style={local.barcodeBarWide} />
              <View style={local.barcodeBar} />
            </View>
          </Pressable>
        </View>
        <View style={[styles.row, local.actions]}>
          <Pressable accessibilityRole="button" style={local.source} onPress={onMyFoods}>
            <Text style={local.actionLabel}>{t.myFoods}</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={credit ? t.closeSource : t.source}
            accessibilityRole="button"
            accessibilityState={{ expanded: credit }}
            onPress={() => setCredit(!credit)}
            style={local.source}
          >
            <Text style={local.actionLabel}>{t.source}</Text>
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
  const sources = {
    bls: t.bls,
    "open-food-facts": t.openFoodFactsCredit,
    local: t.myFoods,
    usda: "USDA",
  };
  return (
    <FlatList
      data={result.foods}
      keyExtractor={(food) => `${food.id.provider}:${food.id.sourceId}`}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={local.results}
      ListHeaderComponent={
        result.foods.length > 0 ? (
          <View style={local.groupTitle}>
            <Text accessibilityRole="header" style={local.groupText}>
              {t.databaseFoods}
            </Text>
          </View>
        ) : undefined
      }
      ListEmptyComponent={<Notice text={t.noResults} />}
      renderItem={({ item, index }) => {
        const kcal = roundNutritionForDisplay(item.nutrition.nutrients).kcal;
        const energy = kcal === null ? null : displayNumber(kcal, locale, 0);
        const source = sources[item.id.provider];
        const basis = t[nutritionBasis[item.nutrition.basis]];
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${source}, ${energy === null ? t.unavailable : `${energy} kcal`}, ${basis}`}
            onPress={() => onPick(item)}
            style={({ pressed }) => [
              styles.row,
              local.result,
              index === result.foods.length - 1 && local.finalResult,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.stretch}>
              <Text style={local.name}>{item.name}</Text>
              <Text style={styles.meta}>
                {source} · {basis}
              </Text>
            </View>
            <Text style={[energy === null ? styles.meta : styles.body, local.energy]}>
              {energy === null ? (
                t.unavailable
              ) : (
                <>
                  <Text style={styles.numbers}>{energy}</Text>
                  <Text style={styles.meta}> kcal</Text>
                </>
              )}
            </Text>
            <View
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
              style={local.pick}
            >
              <Text style={local.plus}>+</Text>
            </View>
          </Pressable>
        );
      }}
    />
  );
}

const local = StyleSheet.create({
  title: { flex: 1, alignItems: "center", gap: 3 },
  headerSpacer: { width: 44 },
  controls: { paddingHorizontal: 16, paddingTop: 12, gap: 12 },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  searchField: {
    flex: 1,
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 28,
    backgroundColor: colors.surface,
    paddingLeft: 14,
  },
  searchFocused: { borderColor: colors.accent },
  search: {
    ...fontFace(),
    flex: 1,
    minWidth: 0,
    minHeight: 46,
    paddingHorizontal: 10,
    color: colors.text,
    fontSize: 16,
  },
  lens: { width: 17, height: 17 },
  lensCircle: { width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: colors.muted },
  lensHandle: {
    position: "absolute",
    width: 7,
    height: 2,
    right: 0,
    bottom: 2,
    borderRadius: 1,
    backgroundColor: colors.muted,
    transform: [{ rotate: "45deg" }],
  },
  clear: { width: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  clearText: { color: colors.muted, fontSize: 22, lineHeight: 26 },
  barcode: {
    width: 22,
    height: 17,
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "space-between",
    paddingHorizontal: 2,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.text,
  },
  barcodeBar: { width: 1, backgroundColor: colors.text },
  barcodeBarWide: { width: 2, backgroundColor: colors.text },
  actions: { flexWrap: "wrap", gap: 8 },
  source: {
    minHeight: 44,
    alignSelf: "flex-start",
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionLabel: { ...fontFace("600"), color: colors.text, fontSize: 14 },
  results: { padding: 16 },
  groupTitle: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 7,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: colors.surface,
  },
  groupText: { ...fontFace("700"), color: colors.muted, fontSize: 13, flexShrink: 1 },
  result: {
    minHeight: 66,
    backgroundColor: colors.surface,
    paddingVertical: 9,
    paddingHorizontal: 16,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.field,
  },
  finalResult: { borderBottomLeftRadius: 20, borderBottomRightRadius: 20 },
  name: { ...fontFace("600"), color: colors.text, fontSize: 16, marginBottom: 3 },
  energy: { flexShrink: 1, maxWidth: "32%", textAlign: "right" },
  pick: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.field,
    alignItems: "center",
    justifyContent: "center",
  },
  plus: { color: colors.accent, fontSize: 21, lineHeight: 24 },
});

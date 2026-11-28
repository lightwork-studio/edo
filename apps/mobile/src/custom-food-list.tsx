import type { Food } from "@edo/core";
import { type ComponentRef, type ReactNode, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Strings } from "./strings";
import {
  colors,
  DetailHeader,
  IconButton,
  Notice,
  nutrientValue,
  PrimaryButton,
  styles,
} from "./ui";

export type FoodLibrarySection = "custom" | "favorites" | "recipes" | "savedMeals";

const bases = {
  "per-100-g": "per100g",
  "per-100-ml": "per100ml",
  "per-portion": "perPortion",
} as const;

export function CustomFoodList({
  t,
  locale,
  date,
  foods,
  onBack,
  onCreate,
  onEdit,
  onPick,
  onRetry,
  favorites,
  recipes,
  savedMeals,
  browse,
  match,
}: {
  t: Strings;
  locale: string;
  date: string;
  foods: readonly Food[] | null;
  onBack: () => void;
  onCreate: () => void;
  onEdit: (food: Food) => void;
  onPick: (food: Food) => void;
  onRetry: () => void;
  favorites?: ReactNode;
  recipes?: ReactNode;
  savedMeals?: ReactNode;
  browse?: {
    section: FoodLibrarySection;
    query: string;
    onSection: (section: FoodLibrarySection) => void;
    onQuery: (query: string) => void;
  };
  match?: (name: string) => boolean;
}) {
  const search = useRef<ComponentRef<typeof TextInput>>(null);
  const names = new Intl.Collator(locale);
  const ordered = foods
    ? foods
        .filter((food) => !match || match(food.name))
        .sort(
          (left, right) =>
            names.compare(left.name, right.name) ||
            left.id.sourceId.localeCompare(right.id.sourceId),
        )
    : null;
  const custom = (
    <>
      {ordered === null && (
        <Notice text={t.myFoodsError} action={{ label: t.retry, onPress: onRetry }} />
      )}
      {ordered?.length === 0 && <Notice text={match ? t.libraryNoMatches : t.noCustomFoods} />}
      {ordered?.map((food) => (
        <View key={food.id.sourceId} style={[styles.card, styles.row]}>
          <Pressable
            accessibilityRole="button"
            accessibilityHint={t.addFood}
            style={[styles.stretch, { minHeight: 44, justifyContent: "center" }]}
            onPress={() => onPick(food)}
          >
            <Text style={styles.title}>{food.name}</Text>
            <Text style={styles.meta}>
              {nutrientValue(food.nutrition.nutrients.kcal, locale, "kcal")} ·{" "}
              {t[bases[food.nutrition.basis]]}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.editCustomFoodName(food.name)}
            onPress={() => onEdit(food)}
            style={styles.action}
          >
            <Text style={styles.actionText}>{t.editCustomFood}</Text>
          </Pressable>
        </View>
      ))}
    </>
  );
  const groups = { custom, favorites, recipes, savedMeals };
  const tabs: { id: FoodLibrarySection; label: string }[] = [
    { id: "custom", label: t.myFoods },
    { id: "favorites", label: t.favorites },
    { id: "recipes", label: t.recipes },
    { id: "savedMeals", label: t.savedMeals },
  ];
  return (
    <>
      {browse ? (
        <>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={[styles.title, styles.stretch]}>
              {t.foods}
            </Text>
            {foods && <IconButton label={t.createCustomFood} glyph="+" onPress={onCreate} />}
          </View>
          <View style={local.search}>
            <TextInput
              ref={search}
              accessibilityLabel={t.searchLibrary}
              placeholder={t.searchLibrary}
              placeholderTextColor={colors.muted}
              style={[styles.body, styles.stretch, local.query]}
              value={browse.query}
              onChangeText={browse.onQuery}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
            {browse.query !== "" && (
              <IconButton
                glyph="×"
                label={t.clearSearch}
                onPress={() => {
                  browse.onQuery("");
                  search.current?.focus();
                }}
              />
            )}
          </View>
          <View accessibilityRole="tablist" style={local.tabs}>
            {tabs.map(({ id, label }) => (
              <Pressable
                key={id}
                accessibilityRole="tab"
                accessibilityState={{ selected: id === browse.section }}
                onPress={() => browse.onSection(id)}
                style={[local.tab, id === browse.section && local.selected]}
              >
                <Text style={[styles.body, id === browse.section && local.selectedText]}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : (
        <DetailHeader title={t.myFoods} subtitle={date} back={t.back} onBack={onBack} />
      )}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {browse ? (
          groups[browse.section]
        ) : (
          <>
            {favorites}
            {favorites && (
              <Text accessibilityRole="header" style={styles.title}>
                {t.customFoods}
              </Text>
            )}
            {custom}
            {recipes}
            {savedMeals}
          </>
        )}
      </ScrollView>
      {!browse && ordered !== null && (
        <View style={styles.footer}>
          <PrimaryButton title={t.createCustomFood} onPress={onCreate} />
        </View>
      )}
    </>
  );
}

const local = StyleSheet.create({
  search: {
    marginHorizontal: 16,
    marginTop: 8,
    minHeight: 46,
    paddingLeft: 16,
    paddingRight: 4,
    borderRadius: 23,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
  },
  query: { minWidth: 0, minHeight: 46 },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  tab: {
    maxWidth: "100%",
    minHeight: 44,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 22,
    paddingHorizontal: 12,
  },
  selected: { backgroundColor: colors.text, borderColor: colors.text },
  selectedText: { color: colors.background, fontWeight: "700" },
});

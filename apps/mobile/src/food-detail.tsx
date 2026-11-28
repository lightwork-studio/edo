import {
  type DailyNutritionTarget,
  type DiaryItem,
  type Food,
  type Nutrients,
  nutritionForPortion,
  type Portion,
  roundNutritionForDisplay,
} from "@edo/core";
import { useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  defaultFoodPortion,
  nutritionSum,
  nutritionTargetProgress,
  readAmount,
} from "./diary-view";
import type { Strings } from "./strings";
import {
  colors,
  DetailHeader,
  displayAmount,
  displayNumber,
  macros,
  Notice,
  nutrientValue,
  PrimaryButton,
  Ring,
  styles,
  TargetRing,
} from "./ui";

const reference = {
  "per-100-g": "per100g",
  "per-100-ml": "per100ml",
  "per-portion": "perPortion",
} as const;

function previewNutrition(
  food: Food,
  amount: number | null,
  unit: Portion["unit"],
): Nutrients | null {
  if (amount === null) return null;
  try {
    return nutritionForPortion(food.nutrition, { amount, unit });
  } catch {
    return null;
  }
}

export function FoodDetail({
  t,
  locale,
  date,
  food,
  day,
  originalItem,
  favorite,
  onBack,
  onSave,
}: {
  t: Strings;
  locale: string;
  date: string;
  food: Food;
  day?: { items: readonly Nutrients[]; index: number; target: DailyNutritionTarget };
  originalItem?: DiaryItem;
  favorite?: { selected: boolean; toggle: () => void } | { retry: () => void };
  onBack: () => void;
  onSave: (portion: Portion) => void;
}) {
  const { unit: initialUnit, amount: initial } = originalItem?.portion ?? defaultFoodPortion(food);
  const [unit, setUnit] = useState<Portion["unit"]>(initialUnit);
  const unitLabel = unit === "portion" ? t.portion : unit;
  const initialText = displayAmount(initial, locale);
  const [value, setValue] = useState(initialText);
  const [error, setError] = useState<"invalid" | "save" | null>(null);
  const [favoriteError, setFavoriteError] = useState(false);
  const star = favorite && "toggle" in favorite ? favorite : undefined;
  const submitted = useRef(false);
  const amount = unit === initialUnit && value === initialText ? initial : readAmount(value);
  const proposed =
    originalItem && unit === initialUnit && amount === originalItem.portion.amount
      ? originalItem.nutrients
      : previewNutrition(food, amount, unit);
  const preview = proposed && roundNutritionForDisplay(proposed);
  const before = day && nutritionSum(day.items);
  const beforeDisplay = before && roundNutritionForDisplay(before);
  const daily =
    proposed && day && before
      ? nutritionSum([...day.items.slice(0, day.index), proposed, ...day.items.slice(day.index)])
      : null;
  const dailyDisplay = daily && roundNutritionForDisplay(daily);
  const goals = day && roundNutritionForDisplay({ ...day.target, fiberG: null });
  const energyBalance =
    dailyDisplay?.kcal == null || goals?.kcal == null ? null : goals.kcal - dailyDisplay.kcal;
  const values = [{ label: "energy", nutrient: "kcal", color: colors.accent } as const, ...macros];
  const base = roundNutritionForDisplay(food.nutrition.nutrients);
  const source = {
    bls: t.bls,
    "open-food-facts": t.openFoodFactsCredit,
    local: t.myFoods,
    usda: null,
  }[food.id.provider];
  const noPackagedNutrition =
    food.id.provider === "open-food-facts" &&
    Object.values(food.nutrition.nutrients).every((value) => value === null);
  const units = (["g", "ml", "portion"] as const).filter(
    (candidate) => candidate === initialUnit || previewNutrition(food, 1, candidate) !== null,
  );

  function submit() {
    if (submitted.current) return;
    if (amount === null || preview === null) {
      setError("invalid");
      return;
    }
    submitted.current = true;
    try {
      onSave({ amount, unit });
      Keyboard.dismiss();
    } catch {
      submitted.current = false;
      setError("save");
    }
  }

  function change(next: string) {
    setValue(next);
    setError(null);
  }

  return (
    <>
      <DetailHeader
        title={originalItem ? t.editPortion : t.addFood}
        subtitle={date}
        back={t.back}
        onBack={onBack}
      />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={local.food}>
          <View style={styles.row}>
            <Text accessibilityRole="header" style={[styles.heading, styles.stretch]}>
              {food.name}
            </Text>
            {star && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  star.selected ? t.removeFavorite(food.name) : t.addFavorite(food.name)
                }
                accessibilityState={{ selected: star.selected }}
                onPress={() => {
                  try {
                    star.toggle();
                    setFavoriteError(false);
                  } catch {
                    setFavoriteError(true);
                  }
                }}
                style={styles.iconButton}
              >
                <Text style={[styles.icon, star.selected && local.star]}>
                  {star.selected ? "★" : "☆"}
                </Text>
              </Pressable>
            )}
          </View>
          {favorite && "retry" in favorite && (
            <Notice
              text={t.favoriteListError}
              action={{ label: t.retry, onPress: favorite.retry }}
            />
          )}
          {favoriteError && (
            <Text accessibilityRole="alert" style={styles.error}>
              {t.favoriteError}
            </Text>
          )}
          {source && (
            <Text style={styles.meta}>
              {source}
              {!noPackagedNutrition && ` · ${t[reference[food.nutrition.basis]]}`}
            </Text>
          )}
        </View>
        <View style={styles.card}>
          <Text style={styles.meta}>{t.amount}</Text>
          {units.length > 1 && (
            <View style={local.presets}>
              {units.map((candidate) => (
                <Pressable
                  key={candidate}
                  accessibilityRole="button"
                  accessibilityState={{ selected: unit === candidate }}
                  onPress={() => {
                    if (unit === candidate) return;
                    setUnit(candidate);
                    const next =
                      candidate === initialUnit ? initial : candidate === "portion" ? 1 : 100;
                    change(displayAmount(next, locale));
                  }}
                  style={[local.preset, unit === candidate && local.selected]}
                >
                  <Text style={unit === candidate ? styles.actionText : styles.body}>
                    {candidate === "portion" ? t.portion : candidate}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          <View style={local.amount}>
            <TextInput
              accessibilityLabel={`${t.amount} (${unitLabel})`}
              inputMode="decimal"
              returnKeyType="done"
              onChangeText={change}
              value={value}
              style={local.input}
              selectTextOnFocus
            />
            <Text style={styles.title}>{unitLabel}</Text>
          </View>
          {unit !== "portion" && (
            <View style={local.presets}>
              {[50, 100, 150, 250].map((preset) => (
                <Pressable
                  key={preset}
                  accessibilityRole="button"
                  accessibilityState={{ selected: amount === preset }}
                  onPress={() => change(String(preset))}
                  style={[local.preset, amount === preset && local.selected]}
                >
                  <Text style={amount === preset ? styles.actionText : styles.body}>
                    {preset} {unitLabel}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {error === "invalid" && (
            <Text accessibilityRole="alert" style={styles.error}>
              {t.invalidAmount}
            </Text>
          )}
        </View>
        {preview && (
          <View style={styles.card}>
            <View style={styles.row}>
              <Text accessibilityRole="header" style={[styles.meta, styles.stretch]}>
                {daily ? t.dayWithFood : t.selectedPortion}
              </Text>
              {energyBalance !== null && (
                <Text style={[styles.meta, local.impactBalance]}>
                  <Text style={[styles.body, styles.numbers]}>
                    {displayNumber(Math.abs(energyBalance), locale, 0)}
                  </Text>{" "}
                  {energyBalance < 0 ? t.kcalOverAfterFood : t.kcalLeftAfterFood}
                </Text>
              )}
            </View>
            <View style={local.rings}>
              {values.map(({ label, nutrient, color }) => {
                const value = preview[nutrient];
                const isKcal = nutrient === "kcal";
                const unit = isKcal ? "kcal" : "g";
                const target = day?.target[nutrient] ?? null;
                const prior = nutritionTargetProgress(before?.[nutrient] ?? null, target);
                const after = nutritionTargetProgress(daily?.[nutrient] ?? null, target);
                const afterValue = dailyDisplay?.[nutrient] ?? null;
                const goal = goals?.[nutrient] ?? null;
                const comparison =
                  daily && goal !== null
                    ? `${afterValue === null ? t.unavailable : displayNumber(afterValue, locale, isKcal ? 0 : 1)} / ${displayNumber(goal, locale, isKcal ? 0 : 1)}${isKcal ? "" : " g"}`
                    : null;
                const describe = (amount: number | null | undefined) =>
                  amount == null ? t.unavailable : nutrientValue(amount, locale, unit);
                const numeric = (
                  <Text
                    style={[styles.body, styles.numbers, { color, maxWidth: 42 }]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    {value === null
                      ? "—"
                      : `${daily ? "+" : ""}${displayNumber(value, locale, isKcal ? 0 : 1)}`}
                  </Text>
                );
                return (
                  <View
                    key={nutrient}
                    accessible
                    accessibilityLabel={
                      comparison
                        ? t.dayImpactValue(
                            t[label],
                            describe(beforeDisplay?.[nutrient]),
                            describe(value),
                            describe(afterValue),
                            describe(goal),
                            originalItem !== undefined,
                          )
                        : `${t[label]}, ${describe(value)}`
                    }
                    style={local.metric}
                  >
                    {daily ? (
                      <TargetRing
                        size={60}
                        color={color}
                        fraction={after?.fraction ?? prior?.fraction}
                        baseline={prior?.fraction ?? 0}
                      >
                        {numeric}
                      </TargetRing>
                    ) : (
                      <Ring size={54} color={color}>
                        {numeric}
                      </Ring>
                    )}
                    <Text style={[styles.meta, local.metricName]}>{t[label]}</Text>
                    {comparison ? (
                      <Text style={[styles.meta, local.metricName]}>{comparison}</Text>
                    ) : (
                      value !== null && <Text style={styles.meta}>{unit}</Text>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        )}
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.meta}>
            {noPackagedNutrition
              ? t.barcodeNutritionUnavailable
              : `${t.nutritionBasis} · ${t[reference[food.nutrition.basis]]}`}
          </Text>
          {[...values, { label: "fibre", nutrient: "fiberG" } as const].map(
            ({ label, nutrient }) => (
              <View key={nutrient} style={[styles.row, local.nutritionRow]}>
                <Text style={[styles.body, styles.stretch]}>{t[label]}</Text>
                <Text style={[styles.body, styles.numbers]}>
                  {base[nutrient] === null
                    ? t.unavailable
                    : nutrientValue(base[nutrient], locale, nutrient === "kcal" ? "kcal" : "g")}
                </Text>
              </View>
            ),
          )}
        </View>
      </ScrollView>
      <View style={styles.footer}>
        {error === "save" && (
          <Text accessibilityRole="alert" style={[styles.error, local.saveError]}>
            {t.saveError}
          </Text>
        )}
        <PrimaryButton title={originalItem ? t.save : t.add} onPress={submit} />
      </View>
    </>
  );
}

const local = StyleSheet.create({
  food: { gap: 6, paddingHorizontal: 4 },
  star: { color: colors.accent },
  amount: {
    backgroundColor: colors.field,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: 14,
    minHeight: 56,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 28,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    paddingVertical: 8,
  },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  preset: {
    minHeight: 44,
    minWidth: 54,
    flexGrow: 1,
    paddingHorizontal: 5,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  selected: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoft },
  rings: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-around", rowGap: 12 },
  metric: { flex: 1, minWidth: 60, alignItems: "center", gap: 3 },
  metricName: { textAlign: "center", fontSize: 11 },
  impactBalance: { maxWidth: "48%", flexShrink: 1, textAlign: "right" },
  nutritionRow: {
    paddingTop: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  saveError: { marginBottom: 8 },
});

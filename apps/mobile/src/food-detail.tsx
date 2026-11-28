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
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import {
  defaultFoodPortion,
  nutritionSum,
  nutritionTargetProgress,
  readAmount,
} from "./diary-view";
import type { Strings } from "./strings";
import {
  colors,
  displayAmount,
  displayNumber,
  fontFace,
  IconButton,
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
  const { width, fontScale } = useWindowDimensions();
  const compact = width < 350 || fontScale > 1.2;
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
  const measured = food.nutrition.portionSize;
  const sideBySide = !compact && units.length > 1;
  const quantity =
    amount === null
      ? null
      : unit === "portion"
        ? t.foodDetailPortions(displayAmount(amount, locale), amount)
        : `${displayAmount(amount, locale)} ${unit}`;
  const energy = preview?.kcal == null ? null : nutrientValue(preview.kcal, locale, "kcal");
  const action = quantity && preview ? [quantity, energy].filter(Boolean).join(" · ") : null;
  const submitLabel = action
    ? originalItem
      ? t.foodDetailSave(action)
      : t.foodDetailAdd(action)
    : originalItem
      ? t.save
      : t.add;

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
      <View style={[styles.header, local.header]}>
        <IconButton label={t.back} glyph="‹" onPress={onBack} />
        <View style={local.headerTitle}>
          <Text accessibilityRole="header" style={[styles.title, local.center]}>
            {originalItem ? t.editPortion : t.addFood}
          </Text>
          <Text style={[styles.meta, local.center]}>{date}</Text>
        </View>
        <View style={local.headerAction}>
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
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={local.food}>
          <Text accessibilityRole="header" style={styles.heading}>
            {food.name}
          </Text>
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
            <View style={local.source}>
              <Text style={[styles.meta, local.sourceBadge]}>{source}</Text>
              {!noPackagedNutrition && (
                <Text style={styles.meta}>{t[reference[food.nutrition.basis]]}</Text>
              )}
            </View>
          )}
        </View>
        <View style={styles.card}>
          <View style={sideBySide ? local.amountControls : local.stackedAmount}>
            <View style={[local.amount, sideBySide && local.amountColumn]}>
              <TextInput
                accessibilityLabel={`${t.amount} (${unitLabel})`}
                inputMode="decimal"
                returnKeyType="done"
                onChangeText={change}
                value={value}
                style={local.input}
                selectTextOnFocus
              />
              {(unit !== "portion" || units.length < 2) && (
                <Text style={[styles.meta, local.measure]}>{unitLabel}</Text>
              )}
            </View>
            {units.length > 1 && (
              <View style={[local.units, sideBySide && local.unitsColumn]}>
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
                    style={[local.unit, unit === candidate && local.selectedUnit]}
                  >
                    <Text style={[styles.body, local.unitLabel]}>
                      {candidate === "portion" ? t.portion : candidate}
                    </Text>
                    {candidate === "portion" && measured && (
                      <Text style={[styles.meta, local.center]}>
                        {displayAmount(measured.amount, locale)} {measured.unit}
                      </Text>
                    )}
                  </Pressable>
                ))}
              </View>
            )}
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
                    style={[local.metric, compact && local.metricCompact]}
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
        <View style={[styles.card, local.reference]}>
          <Text accessibilityRole="header" style={styles.meta}>
            {noPackagedNutrition
              ? t.barcodeNutritionUnavailable
              : t.foodDetailNutrition(food.nutrition.basis)}
          </Text>
          <View style={compact ? undefined : local.nutritionGrid}>
            {[...values, { label: "fibre", nutrient: "fiberG" } as const].map(
              ({ label, nutrient }) => (
                <View
                  key={nutrient}
                  style={[local.nutritionRow, !compact && local.nutritionColumn]}
                >
                  <Text style={[styles.meta, styles.stretch]}>{t[label]}</Text>
                  <Text style={[styles.body, styles.numbers, local.nutritionValue]}>
                    {base[nutrient] === null
                      ? t.unavailable
                      : nutrientValue(base[nutrient], locale, nutrient === "kcal" ? "kcal" : "g")}
                  </Text>
                </View>
              ),
            )}
          </View>
        </View>
      </ScrollView>
      <View style={styles.footer}>
        {error === "save" && (
          <Text accessibilityRole="alert" style={[styles.error, local.saveError]}>
            {t.saveError}
          </Text>
        )}
        <PrimaryButton title={submitLabel} onPress={submit} />
      </View>
    </>
  );
}

const local = StyleSheet.create({
  header: { paddingHorizontal: 12, gap: 10 },
  headerTitle: { flex: 1, minWidth: 0, gap: 3 },
  headerAction: { width: 44 },
  center: { textAlign: "center" },
  food: { gap: 6, paddingHorizontal: 4 },
  source: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  sourceBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.field,
    ...fontFace("600"),
  },
  star: { color: colors.accent },
  amountControls: { flexDirection: "row", gap: 10 },
  stackedAmount: { gap: 8 },
  amount: {
    minWidth: 0,
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
    ...fontFace("700"),
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 28,
    fontVariant: ["tabular-nums"],
    paddingVertical: 8,
  },
  amountColumn: { flexGrow: 1, flexBasis: "38%" },
  measure: { ...fontFace("700") },
  units: {
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 3,
    borderRadius: 14,
    padding: 4,
    backgroundColor: colors.field,
  },
  unitsColumn: { flexGrow: 1.5, flexBasis: "50%" },
  unit: {
    flex: 1,
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 6,
    paddingVertical: 3,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 10,
  },
  selectedUnit: { backgroundColor: colors.border },
  unitLabel: { ...fontFace("600"), textAlign: "center" },
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
  metricCompact: { flexGrow: 0, flexBasis: "50%" },
  metricName: { textAlign: "center", fontSize: 11 },
  impactBalance: { maxWidth: "48%", flexShrink: 1, textAlign: "right" },
  reference: { gap: 6 },
  nutritionGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  nutritionRow: {
    minHeight: 36,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  nutritionColumn: { width: "47%" },
  nutritionValue: { textAlign: "right", flexShrink: 1 },
  saveError: { marginBottom: 8 },
});

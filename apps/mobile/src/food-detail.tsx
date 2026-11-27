import {
  type DiaryItem,
  type Food,
  type Nutrients,
  nutritionForPortion,
  type Portion,
  roundNutritionForDisplay,
} from "@edo/core";
import { useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { readAmount } from "./diary-view";
import type { Strings } from "./strings";
import {
  colors,
  DetailHeader,
  displayAmount,
  displayNumber,
  macros,
  nutrientValue,
  PrimaryButton,
  Ring,
  styles,
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
    return roundNutritionForDisplay(nutritionForPortion(food.nutrition, { amount, unit }));
  } catch {
    return null;
  }
}

export function FoodDetail({
  t,
  locale,
  date,
  food,
  originalItem,
  onBack,
  onSave,
}: {
  t: Strings;
  locale: string;
  date: string;
  food: Food;
  originalItem?: DiaryItem;
  onBack: () => void;
  onSave: (portion: Portion) => void;
}) {
  const unit = originalItem?.portion.unit ?? "g";
  const unitLabel = unit === "portion" ? t.portion : unit;
  const initial = originalItem?.portion.amount ?? 100;
  const initialText = displayAmount(initial, locale);
  const [value, setValue] = useState(initialText);
  const [error, setError] = useState<"invalid" | "save" | null>(null);
  const submitted = useRef(false);
  const amount = value === initialText ? initial : readAmount(value);
  const preview =
    originalItem && amount === originalItem.portion.amount
      ? roundNutritionForDisplay(originalItem.nutrients)
      : previewNutrition(food, amount, unit);
  const values = [{ label: "energy", nutrient: "kcal", color: colors.accent } as const, ...macros];
  const base = roundNutritionForDisplay(food.nutrition.nutrients);

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
          <Text accessibilityRole="header" style={styles.heading}>
            {food.name}
          </Text>
          {food.id.provider === "bls" && (
            <Text style={styles.meta}>
              {t.bls} · {t[reference[food.nutrition.basis]]}
            </Text>
          )}
        </View>
        <View style={styles.card}>
          <Text style={styles.meta}>{t.amount}</Text>
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
            <Text accessibilityRole="header" style={styles.meta}>
              {t.selectedPortion}
            </Text>
            <View style={local.rings}>
              {values.map(({ label, nutrient, color }) => {
                const value = preview[nutrient];
                const isKcal = nutrient === "kcal";
                return (
                  <View
                    key={nutrient}
                    accessible
                    accessibilityLabel={`${t[label]}, ${value === null ? t.unavailable : nutrientValue(value, locale, isKcal ? "kcal" : "g")}`}
                    style={local.metric}
                  >
                    <Ring size={54} color={color}>
                      <Text
                        style={[styles.body, styles.numbers, { color, maxWidth: 42 }]}
                        numberOfLines={1}
                        adjustsFontSizeToFit
                      >
                        {value === null ? "—" : displayNumber(value, locale, isKcal ? 0 : 1)}
                      </Text>
                    </Ring>
                    <Text style={[styles.meta, local.metricName]}>{t[label]}</Text>
                    {value !== null && <Text style={styles.meta}>{isKcal ? "kcal" : "g"}</Text>}
                  </View>
                );
              })}
            </View>
          </View>
        )}
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.meta}>
            {t.nutritionBasis} · {t[reference[food.nutrition.basis]]}
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
  nutritionRow: {
    paddingTop: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  saveError: { marginBottom: 8 },
});

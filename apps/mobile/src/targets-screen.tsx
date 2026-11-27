import type { DailyNutritionTarget } from "@edo/core";
import type { NutritionTargetRecord } from "@edo/storage";
import { useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Language } from "./strings";
import { previewTarget, type TargetsDraft } from "./targets-form";
import {
  colors,
  displayAmount,
  displayNumber,
  IconButton,
  PrimaryButton,
  Ring,
  styles,
} from "./ui";

const copy = {
  en: {
    back: "Back",
    title: "Targets",
    mode: "How targets are set",
    calculated: "Calculated",
    manual: "Manual",
    body: "From your body",
    coefficient: "Equation coefficient",
    female: "Female",
    male: "Male",
    age: "Age",
    years: "years",
    height: "Height",
    weight: "Weight",
    trend: "from trend",
    activity: "Activity multiplier",
    adjustment: "Goal adjustment",
    adjustmentHint: "Enter a change in kcal per day, such as −250, 0 or +250.",
    maintenance: "Maintenance",
    goal: "Goal",
    savedTarget: "Saved target",
    calories: "Calorie target",
    macros: "Macros",
    perDay: "per day",
    protein: "Protein",
    fat: "Fat",
    fatInitial: "F",
    carbs: "Carbs",
    carbsInitial: "C",
    perKg: "g per kg body weight",
    ofCalories: "of calories",
    automaticCarbs: "Fills the remaining calories",
    save: "Save targets",
    invalidCalories: "Enter a calorie target greater than zero.",
    invalidBody:
      "Select an equation coefficient and enter your age in whole years (18 or older), height, weight, and an activity multiplier of at least 1.",
    invalidAdjustment: "Enter a goal adjustment that leaves a positive calorie target.",
    invalidMacros: "Enter zero or more grams for both protein and fat.",
    overBudget: "Protein and fat exceed your calorie target.",
    saveFailed: "Couldn’t save your targets. Try again.",
  },
  de: {
    back: "Zurück",
    title: "Ziele",
    mode: "Art der Zielsetzung",
    calculated: "Berechnet",
    manual: "Manuell",
    body: "Körperdaten",
    coefficient: "Formelkoeffizient",
    female: "Weiblich",
    male: "Männlich",
    age: "Alter",
    years: "Jahre",
    height: "Größe",
    weight: "Gewicht",
    trend: "aus Trend",
    activity: "Aktivitätsfaktor",
    adjustment: "Zielanpassung",
    adjustmentHint: "Gib eine Änderung in kcal pro Tag ein, etwa −250, 0 oder +250.",
    maintenance: "Erhaltungsbedarf",
    goal: "Ziel",
    savedTarget: "Gespeichertes Ziel",
    calories: "Kalorienziel",
    macros: "Makros",
    perDay: "pro Tag",
    protein: "Eiweiß",
    fat: "Fett",
    fatInitial: "F",
    carbs: "Kohlenhydrate",
    carbsInitial: "K",
    perKg: "g je kg Körpergewicht",
    ofCalories: "der Kalorien",
    automaticCarbs: "Füllen die übrigen Kalorien auf",
    save: "Ziele speichern",
    invalidCalories: "Gib ein Kalorienziel größer als null ein.",
    invalidBody:
      "Wähle einen Formelkoeffizienten und gib dein Alter in ganzen Jahren (ab 18), Größe, Gewicht und einen Aktivitätsfaktor von mindestens 1 ein.",
    invalidAdjustment:
      "Gib eine Zielanpassung ein, bei der das Kalorienziel größer als null bleibt.",
    invalidMacros: "Gib für Eiweiß und Fett jeweils null oder mehr Gramm ein.",
    overBudget: "Eiweiß und Fett überschreiten dein Kalorienziel.",
    saveFailed: "Die Ziele konnten nicht gespeichert werden. Versuche es erneut.",
  },
};

function NumberField({
  label,
  value,
  unit,
  onChangeText,
  inputMode = "decimal",
  hint,
  compact = false,
}: {
  label: string;
  value: string;
  unit?: string;
  onChangeText: (value: string) => void;
  inputMode?: "decimal" | "numeric" | "text";
  hint?: string;
  compact?: boolean;
}) {
  return (
    <View style={compact ? local.macroField : local.field}>
      {!compact && <Text style={local.fieldLabel}>{label}</Text>}
      <View style={local.valueRow}>
        <TextInput
          accessibilityLabel={unit ? `${label} (${unit})` : label}
          accessibilityHint={hint}
          inputMode={inputMode}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          selectTextOnFocus
          placeholder="—"
          placeholderTextColor={colors.muted}
          value={value}
          onChangeText={onChangeText}
          style={[styles.numbers, local.input, compact && local.macroInput]}
        />
        {unit && <Text style={local.unit}>{unit}</Text>}
      </View>
    </View>
  );
}

export function TargetsScreen({
  language,
  locale,
  current,
  suggestedWeightKg,
  onBack,
  onSave,
}: {
  language: Language;
  locale: string;
  current: NutritionTargetRecord | null;
  suggestedWeightKg: number | null;
  onBack: () => void;
  onSave: (mode: NutritionTargetRecord["mode"], target: DailyNutritionTarget) => void;
}) {
  const t = copy[language];
  const [draft, setDraft] = useState<TargetsDraft>(() => ({
    mode: current?.mode ?? "calculated",
    kcal: current ? displayAmount(current.target.kcal, locale) : "",
    weight:
      suggestedWeightKg === null
        ? ""
        : displayAmount(Number(suggestedWeightKg.toFixed(2)) || suggestedWeightKg, locale),
    height: "",
    age: "",
    coefficient: null,
    activity: "",
    adjustment: "",
    protein: current ? displayAmount(current.target.proteinG, locale) : "",
    fat: current ? displayAmount(current.target.fatG, locale) : "",
  }));
  const [weightEdited, setWeightEdited] = useState(false);
  const [error, setError] = useState<ReturnType<typeof previewTarget>["error"] | "saveFailed">(
    null,
  );
  const submitted = useRef(false);
  const { target, maintenanceKcal, kcal, weightKg, error: invalid } = previewTarget(draft);
  const proteinPerKg = target && weightKg !== null ? target.proteinG / weightKg : null;
  const macroRows = [
    {
      key: "protein",
      initial: "P",
      color: colors.protein,
      kcal: target ? target.proteinG * 4 : 0,
      detail:
        proteinPerKg !== null && Number.isFinite(proteinPerKg)
          ? `≈ ${displayNumber(proteinPerKg, locale)} ${t.perKg}`
          : null,
    },
    {
      key: "fat",
      initial: t.fatInitial,
      color: colors.fat,
      kcal: target ? target.fatG * 9 : 0,
      detail: target
        ? `${new Intl.NumberFormat(locale, { style: "percent" }).format((target.fatG * 9) / target.kcal)} ${t.ofCalories}`
        : null,
    },
    {
      key: "carbs",
      initial: t.carbsInitial,
      color: colors.carbs,
      kcal: target ? target.availableCarbohydratesG * 4 : 0,
      detail: t.automaticCarbs,
    },
  ] as const;
  const weightLabel = !weightEdited && draft.weight ? `${t.weight} · ${t.trend}` : t.weight;

  function change<Key extends keyof TargetsDraft>(key: Key, value: TargetsDraft[Key]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    if (key === "weight") setWeightEdited(true);
    setError(null);
  }

  function submit() {
    if (submitted.current) return;
    if (invalid) {
      setError(invalid);
      return;
    }
    submitted.current = true;
    try {
      onSave(draft.mode, target);
      Keyboard.dismiss();
    } catch {
      submitted.current = false;
      setError("saveFailed");
    }
  }

  return (
    <>
      <View style={[styles.header, local.header]}>
        <IconButton label={t.back} glyph="‹" onPress={onBack} />
        <Text accessibilityRole="header" style={[styles.title, local.title]}>
          {t.title}
        </Text>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View accessibilityRole="radiogroup" accessibilityLabel={t.mode} style={local.modes}>
          {(["calculated", "manual"] as const).map((mode) => (
            <Pressable
              key={mode}
              accessibilityRole="radio"
              accessibilityState={{ checked: draft.mode === mode }}
              onPress={() => {
                Keyboard.dismiss();
                change("mode", mode);
              }}
              style={[local.mode, draft.mode === mode && local.selected]}
            >
              <Text style={[local.modeLabel, draft.mode === mode && local.selectedLabel]}>
                {t[mode]}
              </Text>
            </Pressable>
          ))}
        </View>
        {draft.mode === "calculated" ? (
          <View style={[styles.card, local.card]}>
            <Text accessibilityRole="header" style={local.sectionTitle}>
              {t.body}
            </Text>
            <View style={local.fieldRow}>
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={t.coefficient}
                style={local.field}
              >
                <Text style={local.fieldLabel}>{t.coefficient}</Text>
                <View style={local.coefficients}>
                  {(["female", "male"] as const).map((coefficient) => (
                    <Pressable
                      key={coefficient}
                      accessibilityRole="radio"
                      accessibilityLabel={`${t.coefficient}, ${t[coefficient]}`}
                      accessibilityState={{ checked: draft.coefficient === coefficient }}
                      onPress={() => change("coefficient", coefficient)}
                      style={[
                        local.coefficient,
                        draft.coefficient === coefficient && local.selected,
                      ]}
                    >
                      <Text
                        style={[
                          local.coefficientLabel,
                          draft.coefficient === coefficient && local.selectedLabel,
                        ]}
                      >
                        {t[coefficient]}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              <NumberField
                label={t.age}
                value={draft.age}
                unit={t.years}
                inputMode="numeric"
                onChangeText={(value) => change("age", value)}
              />
            </View>
            <View style={local.fieldRow}>
              <NumberField
                label={t.height}
                value={draft.height}
                unit="cm"
                onChangeText={(value) => change("height", value)}
              />
              <NumberField
                label={weightLabel}
                value={draft.weight}
                unit="kg"
                onChangeText={(value) => change("weight", value)}
              />
            </View>
            <View style={local.fieldRow}>
              <NumberField
                label={t.activity}
                value={draft.activity}
                unit="×"
                onChangeText={(value) => change("activity", value)}
              />
              <NumberField
                label={t.adjustment}
                value={draft.adjustment}
                unit="kcal"
                inputMode="text"
                hint={t.adjustmentHint}
                onChangeText={(value) => change("adjustment", value)}
              />
            </View>
            <View style={local.estimate}>
              {kcal === null && current && (
                <Text style={styles.meta}>
                  {t.savedTarget} · {displayNumber(current.target.kcal, locale, 0)} kcal
                </Text>
              )}
              {maintenanceKcal !== null && (
                <Text style={styles.meta}>
                  {t.maintenance} ≈{" "}
                  <Text style={local.estimateValue}>
                    {displayNumber(maintenanceKcal, locale, 0)}
                  </Text>
                  {" → "}
                  {t.goal}{" "}
                  <Text style={[local.estimateValue, local.goalValue]}>
                    {kcal === null ? "—" : displayNumber(kcal, locale, 0)}
                  </Text>{" "}
                  kcal
                </Text>
              )}
              <Text style={local.fieldLabel}>Mifflin–St Jeor</Text>
              {kcal === null && <Text style={local.fieldLabel}>{t.adjustmentHint}</Text>}
            </View>
          </View>
        ) : (
          <View style={[styles.card, local.card]}>
            <NumberField
              label={t.calories}
              value={draft.kcal}
              unit="kcal"
              onChangeText={(value) => change("kcal", value)}
            />
          </View>
        )}
        <View style={[styles.card, local.card]}>
          <View style={styles.row}>
            <Text accessibilityRole="header" style={[local.sectionTitle, styles.stretch]}>
              {t.macros}
            </Text>
            <Text style={local.fieldLabel}>{t.perDay}</Text>
          </View>
          {macroRows.map(({ key, color, initial, detail }) => (
            <View
              key={key}
              style={[styles.row, local.macroRow, key !== "protein" && local.divider]}
            >
              <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Ring size={38} color={color}>
                  <Text style={[local.macroInitial, { color }]}>{initial}</Text>
                </Ring>
              </View>
              <View style={styles.stretch}>
                <Text style={local.macroLabel}>{t[key]}</Text>
                {detail && <Text style={local.fieldLabel}>{detail}</Text>}
              </View>
              {key === "carbs" ? (
                <Text style={[local.macroField, local.carbs, styles.numbers]}>
                  {target ? displayNumber(target.availableCarbohydratesG, locale) : "—"}{" "}
                  <Text style={local.unit}>g</Text>
                </Text>
              ) : (
                <NumberField
                  compact
                  label={t[key]}
                  value={draft[key]}
                  unit="g"
                  onChangeText={(value) => change(key, value)}
                />
              )}
            </View>
          ))}
          {target && (
            <>
              <View style={local.breakdown}>
                {[macroRows[0], macroRows[2], macroRows[1]].map(({ key, color, kcal }) =>
                  kcal > 0 ? (
                    <View
                      key={key}
                      style={[
                        local.breakdownSegment,
                        { backgroundColor: color, flex: kcal / target.kcal },
                      ]}
                    />
                  ) : null,
                )}
              </View>
              <Text style={local.fieldLabel}>
                {displayNumber(macroRows[0].kcal, locale)} +{" "}
                {displayNumber(macroRows[2].kcal, locale)} +{" "}
                {displayNumber(macroRows[1].kcal, locale)} ≈{" "}
                <Text style={local.estimateValue}>{displayNumber(target.kcal, locale)} kcal</Text>
              </Text>
            </>
          )}
        </View>
      </ScrollView>
      <View style={[styles.footer, local.footer]}>
        {error && (
          <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>
            {t[error]}
          </Text>
        )}
        <PrimaryButton title={t.save} onPress={submit} />
      </View>
    </>
  );
}

const local = StyleSheet.create({
  header: { paddingLeft: 12, paddingRight: 68 },
  title: { flex: 1, textAlign: "center" },
  modes: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: 24, padding: 3 },
  mode: {
    flex: 1,
    minHeight: 44,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  modeLabel: { color: colors.muted, fontSize: 14, fontWeight: "600", textAlign: "center" },
  selected: { backgroundColor: colors.border },
  selectedLabel: { color: colors.text, fontWeight: "700" },
  card: { borderRadius: 18, padding: 12, gap: 6 },
  sectionTitle: { color: colors.muted, fontSize: 13, fontWeight: "600", paddingHorizontal: 2 },
  fieldRow: { flexDirection: "row", gap: 6 },
  field: {
    flex: 1,
    backgroundColor: colors.field,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingTop: 6,
  },
  fieldLabel: { color: colors.muted, fontSize: 12 },
  valueRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    padding: 0,
    color: colors.text,
    fontSize: 15,
  },
  unit: { color: colors.muted, fontSize: 12, fontWeight: "500" },
  coefficients: { flexDirection: "row", gap: 2 },
  coefficient: {
    flex: 1,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 10,
    marginBottom: 2,
    marginTop: 2,
  },
  coefficientLabel: { color: colors.muted, fontSize: 12, textAlign: "center" },
  estimate: {
    borderTopColor: colors.field,
    borderTopWidth: 1,
    marginTop: 4,
    paddingTop: 8,
    gap: 3,
  },
  estimateValue: { color: colors.text, fontWeight: "700", fontVariant: ["tabular-nums"] },
  goalValue: { color: colors.accent, fontSize: 17 },
  macroRow: { minHeight: 52 },
  divider: { borderTopColor: colors.field, borderTopWidth: 1 },
  macroInitial: { fontSize: 12, fontWeight: "700" },
  macroLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  macroField: { width: 96, backgroundColor: colors.field, borderRadius: 12, paddingHorizontal: 10 },
  macroInput: { fontSize: 17, textAlign: "right" },
  carbs: {
    borderColor: colors.border,
    borderWidth: 1,
    borderStyle: "dashed",
    color: colors.text,
    fontSize: 17,
    paddingVertical: 11,
    textAlign: "right",
  },
  breakdown: { height: 8, flexDirection: "row", gap: 2, marginTop: 4 },
  breakdownSegment: { borderRadius: 4 },
  footer: { borderTopColor: colors.surface, borderTopWidth: 1, gap: 8 },
});

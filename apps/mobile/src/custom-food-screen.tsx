import type { Food, Nutrients } from "@edo/core";
import { useRef, useState } from "react";
import {
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { type CustomFoodDraft, type CustomFoodFields, previewCustomFood } from "./custom-food-form";
import { type Language, strings } from "./strings";
import {
  colors,
  displayAmount,
  displayNumber,
  IconButton,
  macros,
  PrimaryButton,
  styles,
} from "./ui";

const copy = {
  en: {
    create: "Create food",
    edit: "Edit food",
    close: "Close food editor",
    name: "Name",
    nutrition: "Nutrition",
    unknown: "Leave unknown values blank.",
    macroEnergy: (value: string) => `The entered macros add up to about ${value} kcal.`,
    portionSize: "Size of one portion (optional)",
    portionUnit: "Portion unit",
    save: "Save food",
    remove: "Delete food",
    removeTitle: "Delete this food?",
    removeDetail: "Meals you already logged will keep their portions and nutrition.",
    cancel: "Cancel",
    removeFailed: "Couldn’t delete this food. Try again.",
    invalidName: "Enter a name for the food.",
    invalidNutrient: "Enter zero or a positive number for each known nutrient.",
    invalidPortion: "Enter a portion size greater than zero or leave it blank.",
    invalidPortionUnit: "Use the same unit for the portion size and the nutrition reference.",
    saveFailed: "Couldn’t save this food. Try again.",
  },
  de: {
    create: "Lebensmittel erstellen",
    edit: "Lebensmittel bearbeiten",
    close: "Lebensmittel-Editor schließen",
    name: "Name",
    nutrition: "Nährwerte",
    unknown: "Lass unbekannte Nährwerte leer.",
    macroEnergy: (value: string) => `Die eingetragenen Makros ergeben etwa ${value} kcal.`,
    portionSize: "Größe einer Portion (optional)",
    portionUnit: "Einheit der Portionsgröße",
    save: "Lebensmittel speichern",
    remove: "Lebensmittel löschen",
    removeTitle: "Dieses Lebensmittel löschen?",
    removeDetail: "Bereits erfasste Mahlzeiten behalten ihre Portionsgrößen und Nährwerte.",
    cancel: "Abbrechen",
    removeFailed: "Das Lebensmittel konnte nicht gelöscht werden. Versuche es erneut.",
    invalidName: "Gib einen Namen für das Lebensmittel ein.",
    invalidNutrient: "Gib für bekannte Nährwerte null oder eine positive Zahl ein.",
    invalidPortion: "Gib eine Portionsgröße größer als null ein oder lass das Feld leer.",
    invalidPortionUnit: "Verwende dieselbe Einheit für Portionsgröße und Nährwertbezug.",
    saveFailed: "Das Lebensmittel konnte nicht gespeichert werden. Versuche es erneut.",
  },
};

const macroFields = [...macros, { label: "fibre", nutrient: "fiberG", color: undefined }] as const;

function Choices<Value extends string>({
  label,
  choices,
  current,
  onChange,
}: {
  label: string;
  choices: readonly { value: Value; label: string }[];
  current: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={local.choices}>
      {choices.map(({ value, label }) => (
        <Pressable
          key={value}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === current }}
          onPress={() => onChange(value)}
          style={({ pressed }) => [
            local.choice,
            value === current && local.selected,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[local.choiceLabel, value === current && local.selectedLabel]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function NumberField({
  label,
  value,
  unit,
  color,
  onChange,
}: {
  label: string;
  value: string;
  unit: string;
  color?: string;
  onChange: (value: string) => void;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={[local.field, local.numberField, focused && local.focused]}>
      <View style={local.fieldLabel}>
        {color && <View style={[local.dot, { backgroundColor: color }]} />}
        <Text style={styles.meta}>{label}</Text>
      </View>
      <View style={local.fieldLabel}>
        <TextInput
          accessibilityLabel={`${label} (${unit})`}
          inputMode="decimal"
          autoCapitalize="none"
          autoCorrect={false}
          value={value}
          placeholder="—"
          placeholderTextColor={colors.muted}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChangeText={onChange}
          selectTextOnFocus
          style={[local.input, styles.numbers, styles.stretch]}
        />
        <Text style={styles.meta}>{unit}</Text>
      </View>
    </View>
  );
}

export function CustomFoodScreen({
  language,
  locale,
  current,
  onBack,
  onSave,
  onDelete,
}: {
  language: Language;
  locale: string;
  current: Food | null;
  onBack: () => void;
  onSave: (draft: CustomFoodDraft) => void;
  onDelete?: () => void;
}) {
  const t = strings[language];
  const labels = copy[language];
  const [fields, setFields] = useState<CustomFoodFields>(() => {
    const nutrition = current?.nutrition;
    const format = (value?: number | null) => (value == null ? "" : displayAmount(value, locale));
    return {
      name: current?.name ?? "",
      basis: nutrition?.basis ?? "per-100-g",
      nutrients: {
        kcal: format(nutrition?.nutrients.kcal),
        proteinG: format(nutrition?.nutrients.proteinG),
        availableCarbohydratesG: format(nutrition?.nutrients.availableCarbohydratesG),
        fatG: format(nutrition?.nutrients.fatG),
        fiberG: format(nutrition?.nutrients.fiberG),
      },
      portionAmount: format(nutrition?.portionSize?.amount),
      portionUnit: nutrition?.portionSize?.unit ?? (nutrition?.basis === "per-100-ml" ? "ml" : "g"),
    };
  });
  const [error, setError] = useState<
    ReturnType<typeof previewCustomFood>["error"] | "saveFailed" | "removeFailed"
  >(null);
  const submitted = useRef(false);
  const preview = previewCustomFood(fields, current?.nutrition.gramsPerMilliliter);

  function change<Key extends keyof CustomFoodFields>(key: Key, value: CustomFoodFields[Key]) {
    setFields((previous) => ({ ...previous, [key]: value }));
    setError(null);
  }

  function changeBasis(basis: CustomFoodFields["basis"]) {
    setFields((previous) => ({
      ...previous,
      basis,
      portionUnit:
        previous.portionAmount.trim() || basis === "per-portion"
          ? previous.portionUnit
          : basis === "per-100-ml"
            ? "ml"
            : "g",
    }));
    setError(null);
  }

  function changeNutrient(key: keyof Nutrients, value: string) {
    setFields((previous) => ({
      ...previous,
      nutrients: { ...previous.nutrients, [key]: value },
    }));
    setError(null);
  }

  function save() {
    if (submitted.current) return;
    if (preview.error) {
      setError(preview.error);
      return;
    }
    submitted.current = true;
    try {
      onSave(preview.draft);
      Keyboard.dismiss();
    } catch {
      submitted.current = false;
      setError("saveFailed");
    }
  }

  function confirmDelete() {
    if (!onDelete || submitted.current) return;
    Alert.alert(labels.removeTitle, labels.removeDetail, [
      { text: labels.cancel, style: "cancel" },
      {
        text: labels.remove,
        style: "destructive",
        onPress: () => {
          if (submitted.current) return;
          submitted.current = true;
          try {
            onDelete();
          } catch {
            submitted.current = false;
            setError("removeFailed");
          }
        },
      },
    ]);
  }

  return (
    <>
      <View style={styles.header}>
        <IconButton label={labels.close} glyph="×" onPress={onBack} />
        <Text accessibilityRole="header" style={[styles.title, styles.stretch, local.title]}>
          {current ? labels.edit : labels.create}
        </Text>
        <View style={local.headerSpacer} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={[local.field, local.nameField]}>
          <Text style={styles.meta}>{labels.name}</Text>
          <TextInput
            accessibilityLabel={labels.name}
            value={fields.name}
            onChangeText={(name) => change("name", name)}
            style={local.input}
          />
        </View>
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.meta}>
            {labels.nutrition}
          </Text>
          <Choices
            label={t.nutritionBasis}
            choices={[
              { value: "per-100-g", label: t.per100g },
              { value: "per-100-ml", label: t.per100ml },
              { value: "per-portion", label: t.perPortion },
            ]}
            current={fields.basis}
            onChange={changeBasis}
          />
          <Text style={styles.meta}>{labels.unknown}</Text>
          <NumberField
            label={t.energy}
            value={fields.nutrients.kcal}
            unit="kcal"
            onChange={(value) => changeNutrient("kcal", value)}
          />
          <View style={local.grid}>
            {macroFields.map(({ label, nutrient, color }) => (
              <View key={nutrient} style={local.gridCell}>
                <NumberField
                  label={t[label]}
                  value={fields.nutrients[nutrient]}
                  unit="g"
                  color={color}
                  onChange={(value) => changeNutrient(nutrient, value)}
                />
              </View>
            ))}
          </View>
          {preview.macroKcal !== null && (
            <Text style={styles.meta}>
              {labels.macroEnergy(displayNumber(preview.macroKcal, locale, 0))}
            </Text>
          )}
        </View>
        <View style={styles.card}>
          <NumberField
            label={labels.portionSize}
            value={fields.portionAmount}
            unit={fields.portionUnit}
            onChange={(value) => change("portionAmount", value)}
          />
          <Choices
            label={labels.portionUnit}
            choices={[
              { value: "g", label: "g" },
              { value: "ml", label: "ml" },
            ]}
            current={fields.portionUnit}
            onChange={(unit) => change("portionUnit", unit)}
          />
        </View>
        {onDelete && (
          <Pressable
            accessibilityRole="button"
            onPress={confirmDelete}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Text style={[styles.body, local.delete]}>{labels.remove}</Text>
          </Pressable>
        )}
      </ScrollView>
      <View style={[styles.footer, local.footer]}>
        {error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {labels[error]}
          </Text>
        )}
        <PrimaryButton title={labels.save} onPress={save} />
      </View>
    </>
  );
}

const local = StyleSheet.create({
  title: { textAlign: "center" },
  headerSpacer: { width: 44 },
  field: {
    borderWidth: 1,
    borderColor: "transparent",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  nameField: { backgroundColor: colors.surface },
  numberField: { backgroundColor: colors.field },
  focused: { borderColor: colors.accent },
  input: { color: colors.text, minHeight: 32, padding: 0, fontSize: 17, fontWeight: "600" },
  fieldLabel: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  choices: {
    flexDirection: "row",
    borderRadius: 22,
    backgroundColor: colors.field,
    padding: 3,
    gap: 2,
  },
  choice: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    borderRadius: 19,
    paddingHorizontal: 4,
  },
  choiceLabel: { ...styles.meta, fontWeight: "600", textAlign: "center" },
  selected: { backgroundColor: colors.border },
  selectedLabel: { color: colors.text, fontWeight: "700" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  gridCell: { flexBasis: "46%", flexGrow: 1 },
  delete: { color: colors.fat, fontWeight: "600" },
  footer: { gap: 8 },
});

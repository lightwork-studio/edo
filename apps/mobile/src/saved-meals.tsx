import type { Portion } from "@edo/core";
import type { SavedMealTemplate } from "@edo/storage";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { showTime } from "./diary-view";
import { type MealTemplateOption, selectedMealItems } from "./meal-template-form";
import type { Strings } from "./strings";
import { colors, DetailHeader, displayAmount, Notice, PrimaryButton, styles } from "./ui";

function portionText(portion: Portion, locale: string, t: Strings): string {
  const unit = portion.unit === "portion" ? t.portion : portion.unit;
  return `${displayAmount(portion.amount, locale)} ${unit}`;
}

export function SavedMealEditor({
  t,
  locale,
  date,
  options,
  onBack,
  onSave,
}: {
  t: Strings;
  locale: string;
  date: string;
  options: readonly MealTemplateOption[];
  onBack: () => void;
  onSave: (value: Omit<SavedMealTemplate, "id">) => void;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState(
    () =>
      new Set(
        options.filter(({ initiallySelected }) => initiallySelected).map(({ item }) => item.id),
      ),
  );
  const [error, setError] = useState<"invalid" | "save" | null>(null);
  const submitted = useRef(false);
  function submit() {
    if (submitted.current) return;
    const items = selectedMealItems(options, selected);
    const title = name.trim();
    if (!title || items.length === 0) {
      setError("invalid");
      return;
    }
    submitted.current = true;
    try {
      onSave({ name: title, items });
    } catch {
      submitted.current = false;
      setError("save");
    }
  }
  return (
    <>
      <DetailHeader title={t.saveMealTemplate} subtitle={date} back={t.back} onBack={onBack} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <TextInput
          accessibilityLabel={t.savedMealName}
          placeholder={t.savedMealName}
          placeholderTextColor={colors.muted}
          value={name}
          onChangeText={(value) => {
            setName(value);
            setError(null);
          }}
          returnKeyType="done"
          style={[styles.card, styles.body, { minHeight: 52 }]}
        />
        {options.map((option) => {
          const { item } = option;
          const checked = selected.has(item.id);
          return (
            <Pressable
              key={item.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
              onPress={() => {
                setSelected((previous) => {
                  const next = new Set(previous);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                });
                setError(null);
              }}
              style={[styles.card, styles.row]}
            >
              <View style={styles.stretch}>
                <Text style={styles.title}>{item.food.name}</Text>
                <Text style={styles.meta}>
                  {portionText(item.portion, locale, t)} · {showTime(option, locale)}
                </Text>
              </View>
              {checked && <Text style={styles.actionText}>✓</Text>}
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.footer}>
        {error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error === "invalid" ? t.savedMealInvalid : t.savedMealWriteError}
          </Text>
        )}
        <PrimaryButton title={t.saveMealTemplate} onPress={submit} />
      </View>
    </>
  );
}

export function SavedMealList({
  t,
  locale,
  templates,
  onLog,
  onRetry,
}: {
  t: Strings;
  locale: string;
  templates: readonly SavedMealTemplate[] | null;
  onLog: (template: SavedMealTemplate) => void;
  onRetry: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  if (templates?.length === 0) return null;
  const names = new Intl.Collator(locale);
  const ordered = templates
    ? [...templates].sort(
        (left, right) => names.compare(left.name, right.name) || left.id.localeCompare(right.id),
      )
    : null;
  return (
    <>
      <Text accessibilityRole="header" style={styles.title}>
        {t.savedMeals}
      </Text>
      {templates === null && (
        <Notice text={t.savedMealReadError} action={{ label: t.retry, onPress: onRetry }} />
      )}
      {ordered?.map((template) => {
        const summary = template.items
          .map(({ food, portion }) => `${food.name} · ${portionText(portion, locale, t)}`)
          .join(", ");
        return (
          <Pressable
            key={template.id}
            accessibilityRole="button"
            accessibilityLabel={`${t.logSavedMeal(template.name)}, ${summary}`}
            onPress={() => {
              if (submitting.current) return;
              submitting.current = true;
              try {
                onLog(template);
              } catch {
                submitting.current = false;
                setFailed(true);
              }
            }}
            style={({ pressed }) => [styles.card, styles.row, pressed && styles.pressed]}
          >
            <View style={styles.stretch}>
              <Text style={styles.title}>{template.name}</Text>
              <Text style={styles.meta}>{summary}</Text>
            </View>
            <Text style={styles.actionText}>{t.logMealAction}</Text>
          </Pressable>
        );
      })}
      {failed && (
        <Text accessibilityRole="alert" style={styles.error}>
          {t.saveError}
        </Text>
      )}
    </>
  );
}

import type { DailyNutritionTarget } from "@edo/core";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Strings } from "./strings";
import { colors, macros, nutrientValue, styles } from "./ui";

function ProfileRow({
  label,
  value,
  icon,
  children,
  onPress,
}: {
  label: string;
  value?: string;
  icon: ReactNode;
  children: ReactNode;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={value ? { text: value } : undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.row, local.row, pressed && styles.pressed]}
    >
      <View
        style={local.icon}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {icon}
      </View>
      <View style={styles.stretch}>{children}</View>
      <Text importantForAccessibility="no" accessibilityElementsHidden style={local.chevron}>
        ›
      </Text>
    </Pressable>
  );
}

export function ProfileScreen({
  t,
  locale,
  target,
  onTargets,
  onDiaryFiles,
}: {
  t: Strings;
  locale: string;
  target: DailyNutritionTarget | null;
  onTargets: () => void;
  onDiaryFiles: () => void;
}) {
  const energy = target ? nutrientValue(target.kcal, locale, "kcal") : null;
  const amounts =
    target &&
    macros.map(({ label, nutrient, color }) => ({
      label: t[label],
      color,
      value: nutrientValue(target[nutrient], locale, "g"),
    }));
  const spokenTarget = amounts
    ? [energy, ...amounts.map(({ label, value }) => `${label} ${value}`)].join(", ")
    : undefined;
  return (
    <>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          {t.profile}
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={local.section}>
          {t.nutritionTargets}
        </Text>
        <ProfileRow
          label={t.nutritionTargets}
          value={spokenTarget}
          icon={
            <View style={local.targetIcon}>
              <View style={local.targetCenter} />
            </View>
          }
          onPress={onTargets}
        >
          <Text style={styles.body}>{t.profileNutrition}</Text>
          {amounts && (
            <View style={local.amounts}>
              <Text style={[styles.meta, styles.numbers, local.energy]}>{energy}</Text>
              {amounts.map(({ label, value, color }) => (
                <View key={label} style={local.amount}>
                  <View style={[local.dot, { backgroundColor: color }]} />
                  <Text style={styles.meta}>
                    {label.slice(0, 1)} {value}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </ProfileRow>
        <Text accessibilityRole="header" style={local.section}>
          {t.profileData}
        </Text>
        <ProfileRow
          label={t.diaryFiles}
          icon={
            <View style={local.fileIcon}>
              <View style={local.fileLine} />
              <View style={local.fileLine} />
            </View>
          }
          onPress={onDiaryFiles}
        >
          <Text style={styles.body}>{t.diaryFiles}</Text>
        </ProfileRow>
      </ScrollView>
    </>
  );
}

const local = StyleSheet.create({
  section: { ...styles.meta, marginLeft: 6 },
  row: { minHeight: 52, padding: 10, backgroundColor: colors.surface, borderRadius: 18 },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.field,
  },
  targetIcon: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderColor: colors.accent,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  targetCenter: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent },
  fileIcon: {
    width: 13,
    height: 16,
    borderRadius: 2,
    borderWidth: 1.5,
    borderColor: colors.muted,
    gap: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  fileLine: { width: 5, height: 1, backgroundColor: colors.muted },
  amounts: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 4 },
  amount: { flexDirection: "row", alignItems: "center", gap: 3 },
  energy: { color: colors.text },
  dot: { width: 6, height: 6, borderRadius: 3 },
  chevron: { color: colors.muted, fontSize: 22 },
});

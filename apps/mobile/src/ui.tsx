import type { Nutrients } from "@edo/core";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

export const colors = {
  background: "#141517",
  surface: "#1F2023",
  field: "#292A2E",
  border: "#3A3B40",
  text: "#F4F2EE",
  muted: "#B0ACA5",
  accent: "#F6B84D",
  accentText: "#2B1B00",
  accentSoft: "#F6B84D29",
  protein: "#5FD38D",
  carbs: "#E8DD72",
  fat: "#FF7D8A",
};

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: "700" },
  heading: { color: colors.text, fontSize: 26, fontWeight: "700", letterSpacing: -0.5 },
  body: { color: colors.text, fontSize: 15 },
  meta: { color: colors.muted, fontSize: 13 },
  error: { color: colors.fat, fontSize: 13 },
  card: { backgroundColor: colors.surface, borderRadius: 20, padding: 16, gap: 12 },
  content: { padding: 16, gap: 12 },
  footer: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  stretch: { flex: 1 },
  numbers: { fontVariant: ["tabular-nums"], fontWeight: "700" },
  primary: {
    minHeight: 56,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  primaryText: { color: colors.accentText, fontSize: 16, fontWeight: "700", textAlign: "center" },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface,
    justifyContent: "center",
    alignItems: "center",
  },
  icon: { color: colors.text, fontSize: 26, lineHeight: 30 },
  faded: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  notice: { padding: 24, alignItems: "center", gap: 12 },
  noticeText: { textAlign: "center" },
  actionText: { color: colors.accent, fontSize: 14, fontWeight: "700" },
  action: { minHeight: 44, paddingHorizontal: 8, justifyContent: "center", alignItems: "center" },
});

export function IconButton({
  label,
  glyph,
  onPress,
  disabled = false,
}: {
  label: string;
  glyph: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        disabled && styles.faded,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.icon}>{glyph}</Text>
    </Pressable>
  );
}

export function DetailHeader({
  title,
  subtitle,
  back,
  onBack,
}: {
  title: string;
  subtitle?: string;
  back: string;
  onBack: () => void;
}) {
  return (
    <View style={styles.header}>
      <IconButton label={back} glyph="‹" onPress={onBack} />
      <View style={styles.stretch}>
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {subtitle && <Text style={styles.meta}>{subtitle}</Text>}
      </View>
    </View>
  );
}

export function PrimaryButton({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
    >
      <Text style={styles.primaryText}>{title}</Text>
    </Pressable>
  );
}

export function Notice({
  text,
  pending,
  action,
}: {
  text: string;
  pending?: boolean;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.notice}>
      {pending && <ActivityIndicator color={colors.accent} />}
      <Text accessibilityLiveRegion="polite" style={[styles.meta, styles.noticeText]}>
        {text}
      </Text>
      {action && (
        <Pressable accessibilityRole="button" onPress={action.onPress} style={styles.action}>
          <Text style={styles.actionText}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

export const macros = [
  { label: "protein", nutrient: "proteinG", color: colors.protein },
  { label: "carbs", nutrient: "availableCarbohydratesG", color: colors.carbs },
  { label: "fat", nutrient: "fatG", color: colors.fat },
] as const satisfies ReadonlyArray<{ label: string; nutrient: keyof Nutrients; color: string }>;

export function Ring({
  size,
  color,
  children,
}: {
  size: number;
  color: string;
  children: ReactNode;
}) {
  // A fixed outline frames logged values. Progress arcs need a target.
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: size >= 100 ? 8 : 3,
        borderColor: color,
        alignItems: "center",
        justifyContent: "center",
        padding: 3,
      }}
    >
      {children}
    </View>
  );
}

export function displayNumber(value: number, locale: string, precision = 1): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: precision }).format(value);
}

export function displayAmount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    useGrouping: false,
    maximumSignificantDigits: 17,
    numberingSystem: "latn",
  }).format(value);
}

export function nutrientValue(value: number | null, locale: string, unit: "g" | "kcal"): string {
  return value === null ? "—" : `${displayNumber(value, locale, unit === "kcal" ? 0 : 1)} ${unit}`;
}

export function showDay(day: string, locale: string, today: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    year: day.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
  }).format(new Date(`${day}T00:00:00Z`));
}

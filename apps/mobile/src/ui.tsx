import type { Nutrients } from "@edo/core";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { firstGregorianDisplayDay } from "./diary-calendar";

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

export function PrimaryButton({
  title,
  onPress,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.primary, disabled && styles.faded, pressed && styles.pressed]}
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

export function TargetRing({
  size,
  color,
  fraction,
  baseline,
  children,
}: {
  size: number;
  color: string;
  fraction: number | undefined;
  baseline?: number;
  children: ReactNode;
}) {
  const segmented = baseline !== undefined;
  const rim = segmented ? 6 : size >= 100 ? 13 : size >= 40 ? 4 : 3;
  const circle = { width: size, height: size, borderRadius: size / 2, borderWidth: rim };
  const amount = fraction ?? 0;
  const start = Math.min(baseline ?? 0, amount);
  return (
    <View style={[ringStyles.shell, { width: size, height: size }]}>
      <View
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={StyleSheet.absoluteFill}
      >
        <View style={[circle, ringStyles.paint, { borderColor: colors.field }]} />
        {start > 0 && <TargetArc size={size} rim={rim} color={color} amount={start} dim />}
        {amount > start && (
          <TargetArc
            size={size}
            rim={rim}
            color={color}
            amount={amount - start}
            start={start}
            rounded={!segmented}
          />
        )}
      </View>
      {children}
    </View>
  );
}

function TargetArc({
  size,
  rim,
  color,
  amount,
  start = 0,
  dim = false,
  rounded = false,
}: {
  size: number;
  rim: number;
  color: string;
  amount: number;
  start?: number;
  dim?: boolean;
  rounded?: boolean;
}) {
  const circle = { width: size, height: size, borderRadius: size / 2, borderWidth: rim };
  const opacity = dim ? 0.35 : 1;
  if (amount >= 1) {
    return <View style={[circle, ringStyles.paint, { borderColor: color, opacity }]} />;
  }
  const radians = amount * 2 * Math.PI;
  const radius = (size - rim) / 2;
  const cap = { width: rim, height: rim, borderRadius: rim / 2, backgroundColor: color };
  return (
    <View
      style={[StyleSheet.absoluteFill, { opacity, transform: [{ rotate: `${start * 360}deg` }] }]}
    >
      {/* Each clipped half advances clockwise from its own start point. */}
      {[
        { left: size / 2, offset: -size / 2, degrees: Math.min(amount, 0.5) * 360 - 135 },
        ...(amount > 0.5 ? [{ left: 0, offset: 0, degrees: (amount - 0.5) * 360 + 45 }] : []),
      ].map(({ left, offset, degrees }) => (
        <View key={left} style={[ringStyles.clip, { left, width: size / 2, height: size }]}>
          <View
            style={[
              circle,
              ringStyles.paint,
              {
                left: offset,
                borderTopColor: color,
                borderRightColor: color,
                transform: [{ rotate: `${degrees}deg` }],
              },
            ]}
          />
        </View>
      ))}
      {rounded && (
        <>
          <View style={[ringStyles.cap, cap, { left: radius }]} />
          <View
            style={[
              ringStyles.cap,
              cap,
              {
                left: radius + Math.sin(radians) * radius,
                top: radius - Math.cos(radians) * radius,
              },
            ]}
          />
        </>
      )}
    </View>
  );
}

const ringStyles = StyleSheet.create({
  shell: { alignItems: "center", justifyContent: "center", padding: 3 },
  paint: { position: "absolute", top: 0, left: 0, borderColor: "transparent" },
  clip: { position: "absolute", top: 0, overflow: "hidden" },
  cap: { position: "absolute", top: 0 },
});

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
  if (day < firstGregorianDisplayDay) return day;
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    year: day.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
  }).format(new Date(`${day}T00:00:00Z`));
}

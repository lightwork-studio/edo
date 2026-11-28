import { roundEnergyKcal } from "@edo/core";
import type { DiaryProgressStore, DiaryStore } from "@edo/storage";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { calendarDate, nutritionTargetProgress } from "./diary-view";
import { type ProgressRange, progressSummary, type WeightPoint } from "./progress-data";
import type { Strings } from "./strings";
import {
  colors,
  displayNumber,
  fontFace,
  IconButton,
  macros,
  Notice,
  nutrientValue,
  styles,
  TargetRing,
} from "./ui";

const dayGap = 3;

function WeightChart({ points, locale }: { points: WeightPoint[]; locale: string }) {
  const [width, setWidth] = useState(0);
  const measured = points.flatMap(({ measured, averageKg }) =>
    [measured?.kg, averageKg].filter((value): value is number => typeof value === "number"),
  );
  if (measured.length === 0) return null;
  const low = Math.min(...measured);
  const high = Math.max(...measured);
  const padding = Math.max((high - low) * 0.08, high * Number.EPSILON * 16, 0.2);
  const lower = Math.max(0, low - padding);
  const upper = Math.min(Number.MAX_VALUE, high + padding);
  const height = 124;
  const graphWidth = Math.max(0, width - 12);
  const position = (index: number, kg: number) => ({
    x: 6 + (index * graphWidth) / (points.length - 1),
    y: ((upper - kg) / (upper - lower)) * height,
  });
  const sampleDates = [points[0], points[Math.floor(points.length / 2)], points.at(-1)];
  const labels = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return (
    <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <View style={styles.row}>
        <View style={local.axis}>
          <Text style={styles.meta} numberOfLines={1}>
            {displayNumber(upper, locale, 1)}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {displayNumber(lower, locale, 1)}
          </Text>
        </View>
        <View style={local.chart} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          <View style={local.chartMidline} />
          {width > 12 &&
            points.map((point, index) => {
              const raw = point.measured ? position(index, point.measured.kg) : null;
              const prior = points[index - 1];
              const average = point.averageKg === null ? null : position(index, point.averageKg);
              const previous =
                prior && prior.averageKg !== null ? position(index - 1, prior.averageKg) : null;
              const dx = average && previous ? average.x - previous.x : 0;
              const dy = average && previous ? average.y - previous.y : 0;
              const length = Math.hypot(dx, dy);
              return (
                <View key={point.day} pointerEvents="none" style={StyleSheet.absoluteFill}>
                  {raw && <View style={[local.dot, { left: raw.x - 3, top: raw.y - 3 }]} />}
                  {average && previous && (
                    <View
                      style={[
                        local.line,
                        {
                          width: length,
                          left: (average.x + previous.x - length) / 2,
                          top: (average.y + previous.y) / 2 - 1,
                          transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
                        },
                      ]}
                    />
                  )}
                  {average && !previous && (
                    <View
                      style={[local.averagePoint, { left: average.x - 2, top: average.y - 2 }]}
                    />
                  )}
                </View>
              );
            })}
        </View>
      </View>
      <View style={local.dateAxis}>
        {sampleDates.map((point) =>
          point ? (
            <Text key={point.day} style={styles.meta}>
              {labels.format(calendarDate(point.day))}
            </Text>
          ) : null,
        )}
      </View>
    </View>
  );
}

function loadProgress(diary: DiaryStore & DiaryProgressStore, today: string, range: ProgressRange) {
  try {
    return progressSummary(diary, today, range);
  } catch {
    return null;
  }
}

export function ProgressScreen({
  diary,
  today,
  locale,
  t,
  range,
  savedDay,
  syncNotice,
  onRange,
  onBack,
  onWeight,
  onTargets,
  onArchive,
}: {
  diary: DiaryStore & DiaryProgressStore;
  today: string;
  locale: string;
  t: Strings;
  range: ProgressRange;
  savedDay: string | null;
  syncNotice: ReactNode;
  onRange: (range: ProgressRange) => void;
  onBack: () => void;
  onWeight: () => void;
  onTargets: () => void;
  onArchive: () => void;
}) {
  const [, retry] = useState(0);
  const { fontScale } = useWindowDimensions();
  const dayWidth = Math.ceil(42 * Math.max(1, fontScale));
  const dayRing = Math.ceil(34 * Math.max(1, fontScale));
  const summary = loadProgress(diary, today, range);
  const ranges = [
    { days: 7, label: t.week },
    { days: 30, label: t.month },
    { days: 90, label: t.threeMonths },
  ] as const;
  const latest = summary?.latestWeight;
  let trendStart: { day: string; kg: number } | null = null;
  let trendEnd: { day: string; kg: number } | null = null;
  for (const point of summary?.points ?? []) {
    if (point.averageKg !== null) {
      trendEnd = { day: point.day, kg: point.averageKg };
      trendStart ??= trendEnd;
    }
  }
  const average = summary?.points.at(-1)?.averageKg ?? null;
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const weekdayNarrow = new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" });
  const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const dateText = (day: string) => date.format(calendarDate(day));
  const trend =
    trendStart && trendEnd && trendStart.day !== trendEnd.day
      ? t.weightTrendRange(
          dateText(trendStart.day),
          displayNumber(trendStart.kg, locale, 1),
          dateText(trendEnd.day),
          displayNumber(trendEnd.kg, locale, 1),
        )
      : trendEnd &&
        t.weightTrendLast(dateText(trendEnd.day), displayNumber(trendEnd.kg, locale, 1));
  return (
    <>
      <View style={styles.header}>
        <IconButton glyph="‹" label={t.back} onPress={onBack} />
        <Text accessibilityRole="header" style={[styles.title, styles.stretch]}>
          {t.progress}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.addWeight}
          onPress={onWeight}
          style={local.weightAction}
        >
          <Text
            importantForAccessibility="no"
            accessibilityElementsHidden
            style={styles.actionText}
          >
            +
          </Text>
          <Text style={styles.title}>{t.weight}</Text>
        </Pressable>
      </View>
      {syncNotice && <View style={local.syncNotice}>{syncNotice}</View>}
      {summary ? (
        <ScrollView contentContainerStyle={styles.content}>
          {savedDay && (
            <Text style={styles.actionText} accessibilityLiveRegion="polite">
              {t.weightSaved(dateText(savedDay))}
            </Text>
          )}
          <View style={local.rangeRow}>
            {ranges.map(({ days, label }) => (
              <Pressable
                key={days}
                accessibilityRole="button"
                accessibilityState={{ selected: range === days }}
                onPress={() => onRange(days)}
                style={[local.chip, range === days && local.selected]}
              >
                <Text style={[local.rangeLabel, range === days && local.selectedText]}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.card}>
            <View style={local.spread}>
              <Text accessibilityRole="header" style={[styles.meta, styles.stretch]}>
                {t.weight}
              </Text>
              <Text style={styles.meta}>{t.sevenDayAverage}</Text>
            </View>
            <Text style={[styles.heading, local.large]} numberOfLines={1} adjustsFontSizeToFit>
              {average === null ? "—" : displayNumber(average, locale, 1)}
              {average !== null && <Text style={local.weightUnit}> kg</Text>}
            </Text>
            {latest && (
              <Text style={styles.meta}>
                {t.latestWeight} {dateText(latest.localDay)} · {displayNumber(latest.kg, locale, 1)}{" "}
                kg
              </Text>
            )}
            <WeightChart points={summary.points} locale={locale} />
            {trend && <Text style={styles.meta}>{trend}</Text>}
            {average === null && <Text style={styles.meta}>{t.weightTrendEmpty}</Text>}
          </View>
          <View style={styles.card}>
            <View style={local.spread}>
              <Text accessibilityRole="header" style={[styles.meta, styles.stretch]}>
                {t.progressCalories}
              </Text>
              {summary.averageCalories !== null && (
                <Text style={local.calorieAverage} numberOfLines={2} adjustsFontSizeToFit>
                  {t.progressAverage}{" "}
                  <Text style={[styles.body, styles.numbers]}>
                    {displayNumber(roundEnergyKcal(summary.averageCalories), locale, 0)}
                  </Text>
                  {summary.averageTargets.kcal === null
                    ? " kcal"
                    : ` / ${displayNumber(roundEnergyKcal(summary.averageTargets.kcal), locale, 0)} kcal`}
                </Text>
              )}
            </View>
            <ScrollView
              horizontal
              contentContainerStyle={[
                local.week,
                { minWidth: summary.days.length * (dayWidth + dayGap) - dayGap },
              ]}
              style={local.weekScroller}
            >
              {summary.days.map(({ day, nutrition, target }) => {
                const rawKcal = nutrition?.kcal ?? null;
                const kcal = rawKcal === null ? null : roundEnergyKcal(rawKcal);
                const targetKcal = target?.target.kcal ?? null;
                const roundedTarget = targetKcal === null ? null : roundEnergyKcal(targetKcal);
                const dayDate = calendarDate(day);
                const current = day === today;
                const progress = nutritionTargetProgress(rawKcal, targetKcal);
                const deviation =
                  kcal !== null && roundedTarget !== null && !current ? kcal - roundedTarget : 0;
                const difference = deviation > 0 ? displayNumber(deviation, locale, 0) : null;
                const accessibility = [`${weekday.format(dayDate)}, ${dateText(day)}`];
                if (current) accessibility.push(t.today);
                accessibility.push(
                  kcal === null ? t.unavailable : nutrientValue(kcal, locale, "kcal"),
                );
                if (roundedTarget !== null) {
                  accessibility.push(
                    `${t.targetLabel} ${nutrientValue(roundedTarget, locale, "kcal")}`,
                  );
                }
                if (difference !== null) accessibility.push(t.caloriesOverTarget(difference));
                return (
                  <View
                    key={day}
                    accessible
                    accessibilityLabel={accessibility.join(", ")}
                    style={[local.day, local.weekDay, { minWidth: dayWidth }]}
                  >
                    <Text
                      style={[local.dayCaption, current && local.activeDay]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                    >
                      {weekdayNarrow.format(dayDate)}
                    </Text>
                    <TargetRing
                      size={dayRing}
                      color={current ? colors.accent : colors.muted}
                      fraction={progress?.fraction}
                    >
                      <Text
                        style={[styles.body, styles.numbers]}
                        numberOfLines={1}
                        adjustsFontSizeToFit
                      >
                        {displayNumber(Number(day.slice(-2)), locale, 0)}
                      </Text>
                    </TargetRing>
                    <Text style={[local.dayCaption, current && local.activeDay]}>
                      {kcal === null ? "—" : displayNumber(kcal, locale, 0)}
                    </Text>
                    {difference !== null && (
                      <Text style={[local.dayCaption, local.excess]}>+{difference}</Text>
                    )}
                  </View>
                );
              })}
            </ScrollView>
            {summary.completedDays > 0 && (
              <Text style={styles.meta}>
                {t.progressLoggedDays(
                  displayNumber(summary.completedDays, locale, 0),
                  summary.completedDays,
                )}
              </Text>
            )}
          </View>
          <View style={styles.card}>
            <View style={local.spread}>
              <Text accessibilityRole="header" style={[styles.meta, styles.stretch]}>
                {t.progressMacros}
              </Text>
              <Pressable accessibilityRole="button" style={styles.action} onPress={onTargets}>
                <Text style={styles.actionText}>{t.nutritionTargets}</Text>
              </Pressable>
            </View>
            <View style={local.days}>
              {macros.map(({ label, nutrient, color }) => {
                const value = summary.averageMacros[nutrient];
                const goal = summary.averageTargets[nutrient];
                const progress = nutritionTargetProgress(value, goal);
                const description = [
                  t[label],
                  value === null ? t.unavailable : nutrientValue(value, locale, "g"),
                ];
                if (goal !== null)
                  description.push(`${t.targetLabel} ${nutrientValue(goal, locale, "g")}`);
                return (
                  <View
                    key={nutrient}
                    accessible
                    accessibilityLabel={description.join(", ")}
                    style={[local.day, styles.stretch]}
                  >
                    <TargetRing size={60} color={color} fraction={progress?.fraction}>
                      <Text
                        style={[styles.body, styles.numbers, { color }]}
                        numberOfLines={1}
                        adjustsFontSizeToFit
                      >
                        {value === null ? "—" : displayNumber(value, locale, 1)}
                      </Text>
                    </TargetRing>
                    <Text style={local.macroLabel}>{t[label]}</Text>
                    {(goal !== null || value !== null) && (
                      <Text style={styles.meta}>
                        {goal === null ? "g" : t.progressMacroGoal(displayNumber(goal, locale, 1))}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
            {summary.proteinTargetDays > 0 && (
              <Text style={styles.meta}>
                {t.proteinTargetDays(summary.proteinHits, summary.proteinTargetDays)}
              </Text>
            )}
          </View>
        </ScrollView>
      ) : (
        <Notice
          text={t.progressError}
          action={{ label: t.retry, onPress: () => retry((value) => value + 1) }}
        />
      )}
      <View style={styles.footer}>
        <Pressable accessibilityRole="button" style={styles.action} onPress={onArchive}>
          <Text style={styles.actionText}>{t.diaryFiles}</Text>
        </Pressable>
      </View>
    </>
  );
}

const local = StyleSheet.create({
  axis: { height: 130, maxWidth: 60, justifyContent: "space-between" },
  averagePoint: {
    position: "absolute",
    backgroundColor: colors.accent,
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  chart: {
    flex: 1,
    height: 126,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  chartMidline: {
    position: "absolute",
    top: "50%",
    left: 0,
    right: 0,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  chip: {
    minHeight: 44,
    borderRadius: 24,
    paddingHorizontal: 12,
    borderColor: colors.border,
    borderWidth: 1,
    justifyContent: "center",
  },
  weightAction: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 22,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rangeLabel: { ...styles.body, ...fontFace("600") },
  weightUnit: { ...styles.body, ...fontFace("500"), color: colors.muted },
  dateAxis: {
    marginLeft: 42,
    paddingTop: 6,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  day: { alignItems: "center", gap: 6, minWidth: 0 },
  week: { flexGrow: 1, flexDirection: "row", gap: dayGap },
  weekScroller: { flexGrow: 0 },
  weekDay: { flex: 1 },
  dayCaption: { ...styles.meta, fontSize: 11, maxWidth: "100%", textAlign: "center" },
  activeDay: { ...fontFace("700"), color: colors.accent },
  excess: { ...fontFace("700"), color: colors.text },
  calorieAverage: { ...styles.meta, maxWidth: "60%", flexShrink: 1, textAlign: "right" },
  days: { flexDirection: "row", justifyContent: "space-between", gap: 3 },
  dot: {
    position: "absolute",
    backgroundColor: colors.muted,
    opacity: 0.7,
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  large: { fontSize: 34 },
  line: { position: "absolute", borderRadius: 1, backgroundColor: colors.accent, height: 2 },
  macroLabel: { ...styles.body, textAlign: "center" },
  rangeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  selected: { backgroundColor: colors.text },
  selectedText: { ...fontFace("700"), color: colors.background },
  spread: { ...styles.row, justifyContent: "space-between" },
  syncNotice: { marginHorizontal: 16 },
});

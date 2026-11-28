import type { DiaryProgressStore, DiaryStore } from "@edo/storage";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { calendarDate } from "./diary-view";
import { type ProgressRange, progressSummary, type WeightPoint } from "./progress-data";
import type { Strings } from "./strings";
import { colors, displayNumber, IconButton, macros, Notice, Ring, styles } from "./ui";

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
        <Text accessibilityRole="header" style={[styles.heading, styles.stretch]}>
          {t.progress}
        </Text>
        <Pressable accessibilityRole="button" onPress={onWeight} style={local.chip}>
          <Text style={styles.actionText}>{t.addWeight}</Text>
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
                <Text style={[styles.title, range === days && local.selectedText]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.card}>
            <View style={local.spread}>
              <Text style={styles.meta}>{t.weight}</Text>
              <Text style={styles.meta}>{t.sevenDayAverage}</Text>
            </View>
            <Text style={[styles.heading, local.large]} numberOfLines={1} adjustsFontSizeToFit>
              {average === null ? "—" : `${displayNumber(average, locale, 1)} kg`}
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
              <Text style={[styles.meta, styles.stretch]}>{t.progressCalories}</Text>
              {summary.averageCalories !== null && (
                <Text style={[styles.body, styles.numbers]}>
                  {displayNumber(summary.averageCalories, locale, 0)} kcal
                </Text>
              )}
            </View>
            <View style={local.days}>
              {summary.days.map(({ day, nutrition, target }) => {
                const kcal = nutrition?.kcal;
                const deviation =
                  kcal != null && day !== today && target
                    ? Math.round(kcal) - Math.round(target.target.kcal)
                    : 0;
                const over = deviation > 0;
                const label =
                  kcal == null ? t.unavailable : `${displayNumber(kcal, locale, 0)} kcal`;
                const difference = over ? displayNumber(deviation, locale, 0) : null;
                const accessibility = [weekday.format(calendarDate(day)), label];
                if (difference !== null) accessibility.push(t.caloriesOverTarget(difference));
                return (
                  <View
                    key={day}
                    accessible
                    accessibilityLabel={accessibility.join(", ")}
                    style={local.day}
                  >
                    <Text style={styles.meta} numberOfLines={1}>
                      {weekday.format(calendarDate(day))}
                    </Text>
                    <Ring size={32} color={day === today || over ? colors.accent : colors.border}>
                      <Text style={[styles.body, styles.numbers]}>
                        {calendarDate(day).getUTCDate()}
                      </Text>
                    </Ring>
                    <Text style={styles.meta} numberOfLines={1} adjustsFontSizeToFit>
                      {kcal == null ? "—" : displayNumber(kcal, locale, 0)}
                    </Text>
                    {difference !== null && (
                      <Text style={styles.actionText} numberOfLines={1} adjustsFontSizeToFit>
                        +{difference}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
          <View style={styles.card}>
            <View style={local.spread}>
              <Text style={styles.meta}>{t.progressMacros}</Text>
              <Pressable accessibilityRole="button" style={styles.action} onPress={onTargets}>
                <Text style={styles.actionText}>{t.nutritionTargets}</Text>
              </Pressable>
            </View>
            <View style={local.days}>
              {macros.map(({ label, nutrient, color }) => {
                const value = summary.averageMacros[nutrient];
                return (
                  <View key={nutrient} style={[local.day, styles.stretch]}>
                    <Ring size={52} color={color}>
                      <Text
                        style={[styles.body, styles.numbers]}
                        numberOfLines={1}
                        adjustsFontSizeToFit
                      >
                        {value === null ? "—" : displayNumber(value, locale, 1)}
                      </Text>
                    </Ring>
                    <Text style={styles.body}>{t[label]}</Text>
                    <Text style={styles.meta}>g</Text>
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
  chip: {
    minHeight: 44,
    borderRadius: 24,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
    justifyContent: "center",
  },
  dateAxis: {
    marginLeft: 42,
    paddingTop: 6,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  day: { alignItems: "center", gap: 6, minWidth: 0 },
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
  rangeRow: { flexDirection: "row", gap: 8 },
  selected: { backgroundColor: colors.text },
  selectedText: { color: colors.background },
  spread: { ...styles.row, justifyContent: "space-between" },
  syncNotice: { marginHorizontal: 16 },
});

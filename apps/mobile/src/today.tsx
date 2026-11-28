import {
  type DailyNutritionTarget,
  type Nutrients,
  roundEnergyKcal,
  roundNutritionForDisplay,
} from "@edo/core";
import type { DiaryMeal } from "@edo/storage";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { DiaryDatePicker } from "./diary-date-picker";
import { calendarDate, nutritionTargetProgress, showTime, totalNutrition } from "./diary-view";
import type { Strings } from "./strings";
import {
  colors,
  displayAmount,
  displayNumber,
  fontFace,
  macros,
  Notice,
  nutrientValue,
  showDay,
  styles,
  TargetRing,
} from "./ui";

export type WeekDay = {
  day: string;
  kcal: number | null;
  target: DailyNutritionTarget | null;
};

const weekdayColumns = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export function TodayScreen({
  t,
  locale,
  today,
  lastDay,
  day,
  week,
  meals,
  target,
  feedback,
  syncNotice,
  onDay,
  onEdit,
  onSaveMeal,
  onRetry,
}: {
  t: Strings;
  locale: string;
  today: string;
  lastDay: string;
  day: string;
  week: (WeekDay | null)[];
  meals: DiaryMeal[] | null;
  target: DailyNutritionTarget | null;
  feedback: string | null;
  syncNotice: ReactNode;
  onDay: (day: string) => void;
  onEdit: (mealId: string, itemId: string) => void;
  onSaveMeal: (meal: DiaryMeal) => void;
  onRetry: () => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const nutrition = meals && totalNutrition(meals);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" });
  const { width } = useWindowDimensions();
  const weekMinWidth = week.length * 44;
  const weekPadding = Math.min(12, Math.max(0, (width - weekMinWidth) / 2));
  return (
    <>
      <View style={[styles.header, local.dateHeader]}>
        <Pressable
          accessibilityLabel={`${showDay(day, locale, today)}. ${t.chooseDiaryDay}`}
          accessibilityRole="button"
          accessibilityState={{ expanded: showPicker }}
          onPress={() => setShowPicker(true)}
          style={local.date}
        >
          <Text style={[styles.title, local.dateText]} numberOfLines={1}>
            {showDay(day, locale, today)}
          </Text>
          <View style={local.dateChevron} />
        </Pressable>
      </View>
      {showPicker && (
        <DiaryDatePicker
          t={t}
          locale={locale}
          day={day}
          today={today}
          lastDay={lastDay}
          onClose={() => setShowPicker(false)}
          onChoose={(date) => {
            setShowPicker(false);
            onDay(date);
          }}
        />
      )}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={local.weekScroller}
        contentContainerStyle={[
          local.week,
          { width: Math.max(width, weekMinWidth), paddingHorizontal: weekPadding },
        ]}
      >
        {weekdayColumns.map((column, index) => {
          const entry = week[index];
          if (!entry) {
            // The first and last supported diary weeks can contain blank outer columns.
            return <View key={column} style={local.day} />;
          }
          const selected = entry.day === day;
          const isToday = entry.day === today;
          const unavailable = entry.day > lastDay;
          const date = calendarDate(entry.day);
          const progress = nutritionTargetProgress(entry.kcal, entry.target?.kcal ?? null);
          const color = selected || isToday ? colors.accent : colors.muted;
          const logged = entry.kcal === null ? null : roundEnergyKcal(entry.kcal);
          const goal = entry.target ? roundEnergyKcal(entry.target.kcal) : null;
          const kcal = logged === null ? null : displayNumber(logged, locale, 0);
          const excess =
            logged !== null && goal !== null && logged > goal
              ? displayNumber(logged - goal, locale, 0)
              : null;
          const dayLabel = showDay(entry.day, locale, today);
          const energyLabel = kcal === null ? t.unavailable : `${kcal} kcal`;
          return (
            <Pressable
              key={entry.day}
              accessibilityRole="button"
              accessibilityLabel={`${dayLabel}, ${energyLabel}${excess ? `, ${t.caloriesOverTarget(excess)}` : ""}`}
              accessibilityState={{ selected, disabled: unavailable }}
              disabled={unavailable}
              onPress={() => onDay(entry.day)}
              style={[local.day, selected && local.selectedDay, unavailable && styles.faded]}
            >
              <Text style={[styles.meta, isToday && styles.actionText]}>
                {weekday.format(date)}
              </Text>
              <TargetRing size={34} color={color} fraction={progress?.fraction}>
                <Text
                  style={[styles.body, styles.numbers, selected && styles.actionText]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {date.getUTCDate()}
                </Text>
              </TargetRing>
              <Text
                style={[
                  local.dayTotal,
                  isToday && local.activeCaption,
                  !isToday && excess && local.number,
                ]}
                numberOfLines={1}
                adjustsFontSizeToFit
              >
                {unavailable
                  ? " "
                  : excess
                    ? `+${excess}`
                    : isToday
                      ? t.today.toLocaleLowerCase(locale)
                      : (kcal ?? "—")}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <ScrollView contentContainerStyle={styles.content}>
        {syncNotice}
        {nutrition && <DayNutrition nutrition={nutrition} target={target} locale={locale} t={t} />}
        {meals && !nutrition && <Notice text={t.totalsError} />}
        {feedback && (
          <Text accessibilityLiveRegion="polite" style={styles.actionText}>
            {feedback}
          </Text>
        )}
        {meals === null ? (
          <Notice text={t.dayError} action={{ label: t.retry, onPress: onRetry }} />
        ) : (
          <>
            {meals.length === 0 && (
              <View style={styles.card}>
                <Text style={styles.meta}>{t.noEntries}</Text>
              </View>
            )}
            {meals.map((meal) => (
              <MealCard
                key={meal.id}
                meal={meal}
                locale={locale}
                t={t}
                onEdit={onEdit}
                onSaveMeal={onSaveMeal}
              />
            ))}
          </>
        )}
      </ScrollView>
    </>
  );
}

function DayNutrition({
  nutrition,
  target,
  locale,
  t,
}: {
  nutrition: Nutrients;
  target: DailyNutritionTarget | null;
  locale: string;
  t: Strings;
}) {
  const { width, fontScale } = useWindowDimensions();
  const ringSize = Math.min(150, Math.round(width * 0.385));
  const stack = width < 345 || fontScale >= 1.35;
  const energy = nutritionTargetProgress(nutrition.kcal, target?.kcal ?? null);
  const logged = roundNutritionForDisplay(nutrition);
  const goals = target ? roundNutritionForDisplay({ ...target, fiberG: null }) : null;
  const balance = logged.kcal === null || goals?.kcal == null ? null : goals.kcal - logged.kcal;
  const energyAmount = balance === null ? logged.kcal : Math.abs(balance);
  const energyLabel = balance === null ? t.kcalLogged : balance < 0 ? t.kcalOver : t.kcalLeft;
  return (
    <View style={[styles.card, local.hero]}>
      <View style={[local.heroContent, stack && local.heroStack]}>
        <TargetRing size={ringSize} color={colors.accent} fraction={energy?.fraction}>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            accessibilityLabel={energyAmount === null ? `${t.energy}: ${t.unavailable}` : undefined}
            style={[local.calories, { maxWidth: ringSize - 30 }]}
          >
            {energyAmount === null ? "—" : displayNumber(energyAmount, locale, 0)}
          </Text>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={[styles.meta, { maxWidth: ringSize - 26 }]}
          >
            {energyLabel}
          </Text>
        </TargetRing>
        <View style={[local.macros, stack && local.stackedMacros]}>
          {macros.map(({ label, nutrient, color }) => {
            const progress = nutritionTargetProgress(
              nutrition[nutrient],
              target?.[nutrient] ?? null,
            );
            const used = logged[nutrient];
            const goal = goals?.[nutrient] ?? null;
            const remaining = used === null || goal === null ? null : goal - used;
            const amount = remaining === null ? used : Math.abs(remaining);
            const direction = remaining === null ? "" : remaining < 0 ? t.targetOver : t.targetLeft;
            return (
              <View key={label} style={[styles.row, local.macro]}>
                <TargetRing size={42} color={color} fraction={progress?.fraction}>
                  <Text
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                    style={[local.glyph, { color }]}
                  >
                    {t[label][0]}
                  </Text>
                </TargetRing>
                <View style={styles.stretch}>
                  <Text style={[local.macroAmount, styles.numbers]}>
                    {amount === null ? t.unavailable : `${displayNumber(amount, locale)} g`}
                    {direction && <Text style={local.macroDirection}> {direction}</Text>}
                  </Text>
                  <Text style={styles.meta}>
                    {t[label]}
                    {goal !== null &&
                      ` · ${used === null ? "—" : displayNumber(used, locale)} / ${displayNumber(goal, locale)}`}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      </View>
      {goals?.kcal != null && (
        <View style={local.heroFooter}>
          <Text style={[styles.meta, styles.stretch]}>
            <Text style={local.number}>
              {logged.kcal === null ? "—" : displayNumber(logged.kcal, locale, 0)}
            </Text>{" "}
            {t.targetEaten} ·{" "}
            <Text style={local.number}>{displayNumber(goals.kcal, locale, 0)}</Text> {t.targetLabel}
          </Text>
          {energy?.ratio != null && (
            <Text style={styles.meta}>
              {new Intl.NumberFormat(locale, { style: "percent" }).format(energy.ratio)}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function MealCard({
  meal,
  locale,
  t,
  onEdit,
  onSaveMeal,
}: {
  meal: DiaryMeal;
  locale: string;
  t: Strings;
  onEdit: (mealId: string, itemId: string) => void;
  onSaveMeal: (meal: DiaryMeal) => void;
}) {
  const time = showTime(meal, locale);
  const energy = totalNutrition([meal])?.kcal ?? null;
  return (
    <View style={[styles.card, local.mealCard]}>
      <View style={styles.row}>
        <Text accessibilityRole="header" style={[styles.title, styles.stretch]}>
          {time}
        </Text>
        <Text style={styles.meta}>
          <Text style={[styles.body, local.number]}>
            {energy === null ? "—" : displayNumber(roundEnergyKcal(energy), locale, 0)}
          </Text>{" "}
          kcal
        </Text>
      </View>
      {meal.items.map((item, index) => {
        const amount = `${displayAmount(item.portion.amount, locale)} ${item.portion.unit === "portion" ? t.portion : item.portion.unit}`;
        const kcal = roundNutritionForDisplay(item.nutrients).kcal;
        return (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={`${item.food.name}, ${amount}, ${kcal === null ? t.unavailable : nutrientValue(kcal, locale, "kcal")}`}
            accessibilityHint={t.editPortion}
            onPress={() => onEdit(meal.id, item.id)}
            style={({ pressed }) => [
              styles.row,
              local.item,
              index > 0 && local.itemDivider,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.body, styles.stretch, local.foodName]}>{item.food.name}</Text>
            <Text style={[styles.meta, local.itemAmount]}>{amount}</Text>
            <Text style={[styles.body, local.number, local.itemEnergy]}>
              {kcal === null ? "—" : displayNumber(kcal, locale, 0)}
            </Text>
          </Pressable>
        );
      })}
      {meal.items.length > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.saveMealAt(time, meal.items[0]?.food.name ?? "")}
          onPress={() => onSaveMeal(meal)}
          style={[styles.action, local.saveMeal]}
        >
          <Text style={styles.actionText}>{t.saveMealTemplate}</Text>
        </Pressable>
      )}
    </View>
  );
}

const local = StyleSheet.create({
  dateHeader: { paddingLeft: 20, paddingRight: 12 },
  date: { minHeight: 44, flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  dateText: { flexShrink: 1 },
  dateChevron: {
    width: 7,
    height: 7,
    borderBottomWidth: 1.5,
    borderRightWidth: 1.5,
    borderColor: colors.muted,
    transform: [{ translateY: -2 }, { rotate: "45deg" }],
  },
  weekScroller: { flexGrow: 0, flexShrink: 0 },
  week: { flexDirection: "row", paddingTop: 8, paddingBottom: 4 },
  day: {
    flex: 1,
    minWidth: 0,
    minHeight: 68,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  selectedDay: { borderRadius: 15, backgroundColor: colors.surface },
  activeCaption: { ...fontFace("700"), color: colors.accent },
  dayTotal: { color: colors.muted, fontSize: 11, fontVariant: ["tabular-nums"], maxWidth: "100%" },
  hero: { borderRadius: 24, padding: 16, gap: 14 },
  heroContent: { flexDirection: "row", alignItems: "center", gap: 14 },
  heroStack: { flexDirection: "column" },
  heroFooter: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  calories: {
    ...fontFace("700"),
    color: colors.text,
    fontSize: 29,
    fontVariant: ["tabular-nums"],
  },
  macros: { flex: 1, gap: 10 },
  stackedMacros: { flex: 0, alignSelf: "stretch" },
  macro: { gap: 10 },
  macroAmount: { color: colors.text, fontSize: 18 },
  macroDirection: { ...fontFace("500"), color: colors.muted, fontSize: 13 },
  glyph: { ...fontFace("700"), fontSize: 12 },
  number: { ...fontFace("700"), color: colors.text, fontVariant: ["tabular-nums"] },
  mealCard: { gap: 0, paddingBottom: 4 },
  item: { minHeight: 46, paddingVertical: 8, gap: 9 },
  itemDivider: { borderTopColor: colors.field, borderTopWidth: StyleSheet.hairlineWidth },
  itemAmount: { maxWidth: "34%", flexShrink: 1, textAlign: "right" },
  itemEnergy: { minWidth: 42, maxWidth: "30%", flexShrink: 1, textAlign: "right" },
  foodName: { ...fontFace("600") },
  saveMeal: { alignSelf: "flex-end", paddingHorizontal: 0 },
});

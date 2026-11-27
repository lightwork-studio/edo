import { roundNutritionForDisplay } from "@edo/core";
import type { DiaryMeal } from "@edo/storage";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { calendarDate, showTime, totalNutrition } from "./diary-view";
import type { Strings } from "./strings";
import {
  colors,
  displayAmount,
  displayNumber,
  IconButton,
  macros,
  Notice,
  nutrientValue,
  PrimaryButton,
  Ring,
  showDay,
  styles,
} from "./ui";

export type WeekDay = { day: string; kcal: number | null };

export function TodayScreen({
  t,
  locale,
  today,
  lastDay,
  day,
  week,
  meals,
  kcalTarget,
  feedback,
  onDay,
  onWeek,
  onAdd,
  onProgress,
  onEdit,
  onSaveMeal,
  onRetry,
}: {
  t: Strings;
  locale: string;
  today: string;
  lastDay: string;
  day: string;
  week: WeekDay[];
  meals: DiaryMeal[] | null;
  kcalTarget: number | null;
  feedback: string | null;
  onDay: (day: string) => void;
  onWeek: (offset: number) => void;
  onAdd?: () => void;
  onProgress: () => void;
  onEdit: (mealId: string, itemId: string) => void;
  onSaveMeal: (meal: DiaryMeal) => void;
  onRetry: () => void;
}) {
  const nutrition = meals && totalNutrition(meals);
  const total = nutrition && roundNutritionForDisplay(nutrition);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const includesLastDay = week.some((entry) => entry.day === lastDay);
  return (
    <>
      <View style={styles.header}>
        <IconButton label={t.previousWeek} glyph="‹" onPress={() => onWeek(-7)} />
        <Text accessibilityRole="header" style={[styles.title, styles.stretch, local.date]}>
          {showDay(day, locale, today)}
        </Text>
        {day !== today && (
          <Pressable accessibilityRole="button" onPress={() => onDay(today)} style={styles.action}>
            <Text style={styles.actionText}>{t.today}</Text>
          </Pressable>
        )}
        <IconButton
          label={t.nextWeek}
          glyph="›"
          onPress={() => onWeek(7)}
          disabled={includesLastDay}
        />
      </View>
      <View style={local.week}>
        {week.map((entry) => {
          const selected = entry.day === day;
          const isToday = entry.day === today;
          const unavailable = entry.day > lastDay;
          const date = calendarDate(entry.day);
          const color = selected || isToday ? colors.accent : colors.border;
          const kcal = entry.kcal === null ? "—" : displayNumber(entry.kcal, locale, 0);
          return (
            <Pressable
              key={entry.day}
              accessibilityRole="button"
              accessibilityLabel={`${showDay(entry.day, locale, today)}, ${entry.kcal === null ? t.unavailable : `${kcal} kcal`}`}
              accessibilityState={{ selected, disabled: unavailable }}
              disabled={unavailable}
              onPress={() => onDay(entry.day)}
              style={[local.day, unavailable && styles.faded]}
            >
              <Text style={[styles.meta, isToday && styles.actionText]}>
                {weekday.format(date)}
              </Text>
              <Ring size={34} color={color}>
                <Text style={[styles.body, styles.numbers, selected && styles.actionText]}>
                  {date.getUTCDate()}
                </Text>
              </Ring>
              <Text style={local.dayTotal} numberOfLines={1}>
                {unavailable ? " " : kcal}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {total && (
          <View style={[styles.card, local.hero]}>
            <Ring size={134} color={colors.accent}>
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                accessibilityLabel={
                  total.kcal === null ? `${t.energy}: ${t.unavailable}` : undefined
                }
                style={local.calories}
              >
                {total.kcal === null ? "—" : displayNumber(total.kcal, locale, 0)}
              </Text>
              <Text style={styles.meta}>kcal</Text>
            </Ring>
            <View style={local.macros}>
              {kcalTarget !== null && (
                <Text style={styles.meta}>
                  {t.nutritionTargets} · {displayNumber(kcalTarget, locale, 0)} kcal
                </Text>
              )}
              {macros.map(({ label, nutrient, color }) => (
                <View key={label} style={[styles.row, local.macro]}>
                  <Ring size={19} color={color}>
                    {null}
                  </Ring>
                  <View style={styles.stretch}>
                    <Text style={styles.meta}>{t[label]}</Text>
                    <Text style={[styles.body, styles.numbers]}>
                      {total[nutrient] === null
                        ? t.unavailable
                        : nutrientValue(total[nutrient], locale, "g")}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}
        {meals && !total && <Notice text={t.totalsError} />}
        {feedback && (
          <Text accessibilityLiveRegion="polite" style={styles.actionText}>
            {feedback}
          </Text>
        )}
        {meals === null ? (
          <Notice text={t.dayError} action={{ label: t.retry, onPress: onRetry }} />
        ) : (
          <>
            <Text accessibilityRole="header" style={styles.title}>
              {t.logged}
            </Text>
            {meals.length === 0 && (
              <View style={styles.card}>
                <Text style={styles.meta}>{t.noEntries}</Text>
              </View>
            )}
            {meals.map((meal) => (
              <View key={meal.id} style={styles.card}>
                <View style={styles.row}>
                  <Text style={[styles.meta, styles.stretch]}>{showTime(meal, locale)}</Text>
                  {meal.items.length > 0 && (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => onSaveMeal(meal)}
                      style={styles.action}
                    >
                      <Text style={styles.actionText}>{t.saveMealTemplate}</Text>
                    </Pressable>
                  )}
                </View>
                {meal.items.map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityHint={t.editPortion}
                    onPress={() => onEdit(meal.id, item.id)}
                    style={({ pressed }) => [styles.row, local.item, pressed && styles.pressed]}
                  >
                    <View style={styles.stretch}>
                      <Text style={[styles.body, local.foodName]}>{item.food.name}</Text>
                      <Text
                        style={styles.meta}
                      >{`${displayAmount(item.portion.amount, locale)} ${item.portion.unit === "portion" ? t.portion : item.portion.unit}`}</Text>
                    </View>
                    <Text style={[styles.body, styles.numbers]}>
                      {item.nutrients.kcal === null
                        ? t.unavailable
                        : nutrientValue(
                            roundNutritionForDisplay(item.nutrients).kcal,
                            locale,
                            "kcal",
                          )}
                    </Text>
                    <Text importantForAccessibility="no" style={styles.icon}>
                      ›
                    </Text>
                  </Pressable>
                ))}
              </View>
            ))}
          </>
        )}
      </ScrollView>
      <View style={[styles.footer, styles.row]}>
        <View style={styles.stretch}>
          {onAdd && <PrimaryButton title={`+  ${t.addFood}`} onPress={onAdd} />}
        </View>
        <Pressable accessibilityRole="button" style={styles.action} onPress={onProgress}>
          <Text style={styles.actionText}>{t.progress}</Text>
        </Pressable>
      </View>
    </>
  );
}

const local = StyleSheet.create({
  date: { textAlign: "center" },
  week: { flexDirection: "row", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  day: {
    flex: 1,
    minWidth: 0,
    minHeight: 68,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  dayTotal: { color: colors.muted, fontSize: 11, fontVariant: ["tabular-nums"], maxWidth: "100%" },
  hero: { flexDirection: "row", alignItems: "center", gap: 16, padding: 18 },
  calories: {
    color: colors.accent,
    fontSize: 29,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    maxWidth: 106,
  },
  macros: { flex: 1, gap: 8 },
  macro: { gap: 8 },
  item: { minHeight: 44 },
  foodName: { fontWeight: "600", marginBottom: 3 },
});

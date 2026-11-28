import { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { diaryMonthWeeks, shiftDiaryMonth } from "./diary-calendar";
import { addDays, calendarDate, mondayOf } from "./diary-view";
import type { Strings } from "./strings";
import { colors, IconButton, styles } from "./ui";

export function DiaryDatePicker({
  t,
  locale,
  day,
  today,
  lastDay,
  onChoose,
  onClose,
}: {
  t: Strings;
  locale: string;
  day: string;
  today: string;
  lastDay: string;
  onChoose: (day: string) => void;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(`${day.slice(0, 7)}-01`);
  const previous = shiftDiaryMonth(month, -1);
  const next = shiftDiaryMonth(month, 1);
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(420, width);
  const cellSize = Math.max(44, Math.floor((panelWidth - 12) / 7));
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const era = month.startsWith("0000") ? "short" : undefined;
  const dateLabel = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    era,
    timeZone: "UTC",
  });
  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    era,
    timeZone: "UTC",
  });
  const monday = mondayOf(today);
  const weekdays = Array.from({ length: 7 }, (_, index) => addDays(monday, index));

  return (
    <Modal animationType="fade" transparent onRequestClose={onClose}>
      <SafeAreaView style={local.overlay}>
        <Pressable accessible={false} onPress={onClose} style={StyleSheet.absoluteFill} />
        <View
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          style={[local.sheet, { width: panelWidth }]}
        >
          <ScrollView bounces={false} contentContainerStyle={local.sheetContent}>
            <Text accessibilityRole="header" style={[styles.title, local.center]}>
              {t.chooseDiaryDay}
            </Text>
            <View style={[styles.header, local.month]}>
              <IconButton
                label={t.previousMonth}
                glyph="‹"
                onPress={() => previous && setMonth(previous)}
                disabled={!previous}
              />
              <Text
                accessibilityLiveRegion="polite"
                style={[styles.title, styles.stretch, local.center]}
              >
                {monthLabel.format(calendarDate(month))}
              </Text>
              <IconButton
                label={t.nextMonth}
                glyph="›"
                onPress={() => next && setMonth(next)}
                disabled={!next || next > lastDay}
              />
            </View>
            <ScrollView horizontal bounces={false} contentContainerStyle={local.grid}>
              <View>
                <View style={local.week}>
                  {weekdays.map((date) => (
                    <Text key={date} style={[styles.meta, local.center, { width: cellSize }]}>
                      {weekday.format(calendarDate(date))}
                    </Text>
                  ))}
                </View>
                {diaryMonthWeeks(month).map((week) => (
                  <View key={week.find(Boolean) ?? month} style={local.week}>
                    {weekdays.map((weekday, index) => {
                      const date = week[index];
                      const cell = { width: cellSize };
                      if (!date) return <View key={weekday} style={cell} />;
                      const selected = date === day;
                      const disabled = date > lastDay;
                      return (
                        <Pressable
                          key={date}
                          accessibilityRole="button"
                          accessibilityLabel={dateLabel.format(calendarDate(date))}
                          accessibilityState={{ selected, disabled }}
                          disabled={disabled}
                          onPress={() => onChoose(date)}
                          style={[
                            local.cell,
                            cell,
                            selected && local.selected,
                            disabled && styles.faded,
                          ]}
                        >
                          <Text
                            style={[
                              styles.body,
                              selected && styles.actionText,
                              date === today && styles.numbers,
                            ]}
                          >
                            {Number(date.slice(-2))}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ))}
              </View>
            </ScrollView>
            <View style={[styles.header, local.actions]}>
              <Pressable accessibilityRole="button" onPress={onClose} style={styles.action}>
                <Text style={styles.body}>{t.cancelDatePicker}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => onChoose(today)}
                style={styles.action}
              >
                <Text style={styles.actionText}>{t.today}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const local = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0009" },
  sheet: { maxHeight: "96%", borderRadius: 24, backgroundColor: colors.surface },
  sheetContent: { paddingVertical: 12, gap: 6 },
  center: { textAlign: "center" },
  grid: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 6 },
  month: { gap: 8, paddingHorizontal: 12 },
  week: { flexDirection: "row" },
  cell: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 14 },
  selected: { backgroundColor: colors.accentSoft },
  actions: { justifyContent: "space-between" },
});

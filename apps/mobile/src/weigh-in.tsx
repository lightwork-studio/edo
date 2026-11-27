import { sevenDayWeightAverage, type WeighIn } from "@edo/core";
import { randomUUID } from "expo-crypto";
import { useRef, useState } from "react";
import { Keyboard, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { calendarDate, entryTime, readAmount } from "./diary-view";
import { validWeighInDay } from "./progress-data";
import type { Strings } from "./strings";
import {
  colors,
  DetailHeader,
  displayAmount,
  displayNumber,
  IconButton,
  PrimaryButton,
  styles,
} from "./ui";

export function WeighInScreen({
  today,
  recent,
  readWindow,
  locale,
  t,
  onBack,
  onSave,
}: {
  today: string;
  recent: readonly WeighIn[];
  readWindow: (through: string) => readonly WeighIn[] | null;
  locale: string;
  t: Strings;
  onBack: () => void;
  onSave: (entry: WeighIn) => void;
}) {
  const [id] = useState(randomUUID);
  const [day, setDay] = useState(today);
  const [value, setValue] = useState("");
  const [error, setError] = useState<"day" | "weight" | "save" | null>(null);
  const submitted = useRef(false);
  const selected = validWeighInDay(day, today);
  const kg = readAmount(value);
  const recentEntries = recent.slice(-5).reverse();
  const dateLabel = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const event = selected && kg !== null ? entryTime(selected, new Date()) : null;
  const candidate =
    event && event.day === selected && kg !== null
      ? { id, localDay: event.day, occurredAt: event.occurredAt, kg }
      : null;
  const window = candidate ? readWindow(candidate.localDay) : null;
  const predicted =
    candidate && window
      ? sevenDayWeightAverage(candidate.localDay, [...window, candidate]).kg
      : null;

  function adjust(by: number) {
    const baseline = kg ?? recent.at(-1)?.kg;
    if (baseline === undefined) return;
    const next = Math.round((baseline + by) * 10) / 10;
    if (next > 0) {
      setError(null);
      setValue(displayAmount(next, locale));
    }
  }

  function save() {
    if (submitted.current) return;
    if (!candidate) {
      setError(selected && kg === null ? "weight" : "day");
      return;
    }
    submitted.current = true;
    try {
      onSave(candidate);
      Keyboard.dismiss();
    } catch {
      submitted.current = false;
      setError("save");
    }
  }

  return (
    <>
      <DetailHeader
        title={t.addWeight}
        subtitle={selected === today ? t.today : day}
        back={t.back}
        onBack={onBack}
      />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.meta}>{t.weighInDay}</Text>
          <TextInput
            accessibilityLabel={t.weighInDay}
            style={local.input}
            value={day}
            onChangeText={(text) => {
              setDay(text);
              setError(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={10}
          />
          <Text style={styles.meta}>{t.weighInAmount}</Text>
          <View style={styles.row}>
            <IconButton
              label={t.decreaseWeight}
              glyph="−"
              onPress={() => adjust(-0.1)}
              disabled={kg === null && recent.length === 0}
            />
            <TextInput
              accessibilityLabel={t.weighInAmount}
              style={[local.input, styles.numbers, styles.stretch, local.weight]}
              inputMode="decimal"
              value={value}
              onChangeText={(text) => {
                setValue(text);
                setError(null);
              }}
              returnKeyType="done"
            />
            <Text style={styles.meta}>kg</Text>
            <IconButton
              label={t.increaseWeight}
              glyph="+"
              onPress={() => adjust(0.1)}
              disabled={kg === null && recent.length === 0}
            />
          </View>
          {predicted !== null && (
            <Text style={styles.meta}>
              {t.sevenDayAverage} · {displayNumber(predicted, locale, 1)} kg
            </Text>
          )}
          {error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error === "day"
                ? t.invalidWeighInDay
                : error === "weight"
                  ? t.invalidWeight
                  : t.weightSaveError}
            </Text>
          )}
        </View>
        {recentEntries.length > 0 && (
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.title}>
              {t.recentWeights}
            </Text>
            {recentEntries.map((entry) => (
              <View key={entry.id} style={local.recent}>
                <Text style={styles.body}>{dateLabel.format(calendarDate(entry.localDay))}</Text>
                <Text style={[styles.body, styles.numbers]}>
                  {displayNumber(entry.kg, locale, 1)} kg
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
      <View style={styles.footer}>
        <PrimaryButton title={t.saveWeight} onPress={save} />
      </View>
    </>
  );
}

const local = StyleSheet.create({
  input: {
    backgroundColor: colors.field,
    color: colors.text,
    fontSize: 17,
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  weight: { fontSize: 24, textAlign: "center", minWidth: 70 },
  recent: { ...styles.row, justifyContent: "space-between" },
});

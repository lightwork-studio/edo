import { type DiaryItem, type Food, type Portion, sevenDayWeightAverage } from "@edo/core";
import type { DiaryMeal, DiaryProgressStore, DiaryStore } from "@edo/storage";
import { getLocales } from "expo-localization";
import { useEffect, useMemo, useState } from "react";
import {
  AppState,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  addDays,
  diaryDayLimit,
  type EntryTime,
  entryTime,
  localDay,
  mondayOf,
  nextMidnight,
  saveFood,
  totalNutrition,
} from "./src/diary-view";
import { FoodDetail } from "./src/food-detail";
import { openLocalCatalog } from "./src/local-catalog";
import { openLocalDiary } from "./src/local-diary";
import { ProgressScreen } from "./src/progress";
import { type ProgressRange, weightWindowStart } from "./src/progress-data";
import { SearchScreen } from "./src/search";
import { appLocale, type Language, strings } from "./src/strings";
import { TargetsScreen } from "./src/targets-screen";
import { TodayScreen } from "./src/today";
import { Notice, showDay, styles } from "./src/ui";
import { useDatabase } from "./src/use-database";
import { WeighInScreen } from "./src/weigh-in";

type LocalDiary = Awaited<ReturnType<typeof openLocalDiary>>;
type SearchContext = EntryTime & { query: string };
type DeviceContext = { today: string; language: Language; locale: string };
type Route =
  | { kind: "diary" }
  | { kind: "progress" }
  | { kind: "weigh-in" }
  | { kind: "targets" }
  | ({ kind: "search" } & SearchContext)
  | ({ kind: "add"; food: Food } & SearchContext)
  | { kind: "edit"; day: string; mealId: string; itemId: string; item: DiaryItem };

function useDeviceContext(): DeviceContext {
  const [today, setToday] = useState(() => localDay(new Date()));
  const [locale, setLocale] = useState(() => appLocale(getLocales()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function refresh() {
      clearTimeout(timer);
      const now = new Date();
      setToday(localDay(now));
      const delay = nextMidnight(now) - now.getTime();
      timer = setTimeout(refresh, delay);
    }
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refresh();
        setLocale(appLocale(getLocales()));
      }
    });
    return () => {
      subscription.remove();
      clearTimeout(timer);
    };
  }, []);
  return { today, ...locale };
}

export default function App() {
  const device = useDeviceContext();
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.screen}>
        <KeyboardAvoidingView
          style={styles.screen}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <DiaryGate {...device} />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function DiaryGate(device: DeviceContext) {
  const { value, retry } = useDatabase(openLocalDiary);
  const t = strings[device.language];

  if (value === null) return <Notice text={t.openingDiary} pending />;
  if (value === "error") {
    return <Notice text={t.diaryError} action={{ label: t.retry, onPress: retry }} />;
  }
  return <DiaryApp connection={value} {...device} />;
}

function readMeals(diary: DiaryStore, day: string): DiaryMeal[] | null {
  try {
    return diary.listMeals(day);
  } catch {
    return null;
  }
}

function readWeights(diary: DiaryProgressStore, through: string, days: number) {
  try {
    return diary.listWeighIns(weightWindowStart(through, days), through);
  } catch {
    return null;
  }
}

function readTarget(diary: DiaryProgressStore, day: string) {
  try {
    return diary.nutritionTargetAt(day);
  } catch {
    return null;
  }
}

function DiaryApp({
  connection,
  today,
  language,
  locale,
}: DeviceContext & { connection: LocalDiary }) {
  const [route, setRoute] = useState<Route>({ kind: "diary" });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [progressRange, setProgressRange] = useState<ProgressRange>(30);
  const [savedWeightDay, setSavedWeightDay] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [feedback, setFeedback] = useState<{ day: string; kind: "saved" | "updated" } | null>(null);
  const catalog = useDatabase(openLocalCatalog, false);
  const t = strings[language];
  const { diary } = connection;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A committed write or retry invalidates the SQLite read.
  const lastDay = useMemo(() => diaryDayLimit(diary, today), [diary, today, refresh]);
  const day = selectedDay && selectedDay <= lastDay ? selectedDay : today;
  const monday = mondayOf(day);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A committed write or retry invalidates the SQLite read.
  const week = useMemo(() => {
    return Array.from({ length: 7 }, (_, index) => {
      const date = addDays(monday, index);
      const meals = date > lastDay ? null : readMeals(diary, date);
      return { day: date, meals, kcal: meals ? (totalNutrition(meals)?.kcal ?? null) : null };
    });
  }, [diary, monday, lastDay, refresh]);
  const meals = week.find((entry) => entry.day === day)?.meals ?? null;

  function goBack() {
    if (route.kind === "diary") return false;
    Keyboard.dismiss();
    if (route.kind === "add") {
      const { day, occurredAt, utcOffsetMinutes, query } = route;
      setRoute({ kind: "search", day, occurredAt, utcOffsetMinutes, query });
    } else if (route.kind === "weigh-in" || route.kind === "targets") {
      setRoute({ kind: "progress" });
    } else {
      setRoute({ kind: "diary" });
    }
    return true;
  }

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", goBack);
    return () => subscription.remove();
  });

  function chooseDay(date: string) {
    setSelectedDay(date === today ? null : date);
    setFeedback(null);
  }

  if (route.kind === "diary") {
    return (
      <TodayScreen
        t={t}
        locale={locale}
        today={today}
        lastDay={lastDay}
        day={day}
        week={week}
        meals={meals}
        kcalTarget={readTarget(diary, day)?.target.kcal ?? null}
        feedback={feedback?.day === day ? t[feedback.kind] : null}
        onDay={chooseDay}
        onWeek={(offset) => {
          const next = addDays(day, offset);
          const withinDiary = next <= lastDay;
          chooseDay(withinDiary ? next : lastDay);
        }}
        onAdd={
          day <= today
            ? () => {
                catalog.start();
                setFeedback(null);
                setRoute({ kind: "search", ...entryTime(selectedDay, new Date()), query: "" });
              }
            : undefined
        }
        onProgress={() => {
          setSavedWeightDay(null);
          setRoute({ kind: "progress" });
        }}
        onEdit={(mealId, itemId) => {
          const meal = meals?.find((entry) => entry.id === mealId);
          const item = meal?.items.find((entry) => entry.id === itemId);
          if (meal && item) {
            setFeedback(null);
            setRoute({ kind: "edit", day: meal.localDay, mealId, itemId, item });
          }
        }}
        onRetry={() => setRefresh((revision) => revision + 1)}
      />
    );
  }

  if (route.kind === "progress") {
    return (
      <ProgressScreen
        diary={diary}
        today={today}
        locale={locale}
        t={t}
        range={progressRange}
        savedDay={savedWeightDay}
        onRange={setProgressRange}
        onBack={goBack}
        onTargets={() => setRoute({ kind: "targets" })}
        onWeight={() => {
          setSavedWeightDay(null);
          setRoute({ kind: "weigh-in" });
        }}
      />
    );
  }
  if (route.kind === "weigh-in") {
    return (
      <WeighInScreen
        today={today}
        recent={readWeights(diary, today, 96) ?? []}
        readWindow={(through) => readWeights(diary, through, 7)}
        locale={locale}
        t={t}
        onBack={goBack}
        onSave={(entry) => {
          if (entry.localDay > localDay(new Date())) {
            throw new RangeError("The weigh-in date is now in the future");
          }
          diary.saveWeighIn(entry);
          setSavedWeightDay(entry.localDay);
          setRoute({ kind: "progress" });
        }}
      />
    );
  }
  if (route.kind === "targets") {
    return (
      <TargetsScreen
        language={language}
        locale={locale}
        current={readTarget(diary, today)}
        suggestedWeightKg={sevenDayWeightAverage(today, readWeights(diary, today, 7) ?? []).kg}
        onBack={goBack}
        onSave={(mode, target) => {
          const now = new Date();
          diary.saveNutritionTarget({
            id: connection.newId(),
            effectiveDay: localDay(now),
            configuredAt: now.getTime(),
            mode,
            target,
          });
          setRoute({ kind: "progress" });
        }}
      />
    );
  }

  const date = showDay(route.day, locale, today);
  if (route.kind === "search") {
    return (
      <SearchScreen
        t={t}
        locale={locale}
        language={language}
        date={date}
        catalog={catalog.value === "error" ? "error" : (catalog.value?.db ?? null)}
        query={route.query}
        onQuery={(query) => setRoute({ ...route, query })}
        onCatalogRetry={catalog.retry}
        onBack={goBack}
        onPick={(food) => {
          Keyboard.dismiss();
          setRoute({ ...route, kind: "add", food });
        }}
      />
    );
  }

  return (
    <FoodDetail
      t={t}
      locale={locale}
      date={date}
      food={route.kind === "add" ? route.food : route.item.food}
      originalItem={route.kind === "edit" ? route.item : undefined}
      onBack={goBack}
      onSave={(portion: Portion) => {
        saveFood(diary, route, portion, connection.newId);
        setSelectedDay(route.day === localDay(new Date()) ? null : route.day);
        setFeedback({ day: route.day, kind: route.kind === "add" ? "saved" : "updated" });
        setRefresh((revision) => revision + 1);
        setRoute({ kind: "diary" });
      }}
    />
  );
}

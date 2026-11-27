import type { DiaryItem, Food, Portion } from "@edo/core";
import type { DiaryMeal, DiaryStore } from "@edo/storage";
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
import { SearchScreen } from "./src/search";
import { appLocale, type Language, strings } from "./src/strings";
import { TodayScreen } from "./src/today";
import { Notice, showDay, styles } from "./src/ui";
import { useDatabase } from "./src/use-database";

type LocalDiary = Awaited<ReturnType<typeof openLocalDiary>>;
type SearchContext = EntryTime & { query: string };
type DeviceContext = { today: string; language: Language; locale: string };
type Route =
  | { kind: "diary" }
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

function DiaryApp({
  connection,
  today,
  language,
  locale,
}: DeviceContext & { connection: LocalDiary }) {
  const [route, setRoute] = useState<Route>({ kind: "diary" });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
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

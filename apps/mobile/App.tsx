import { type DiaryItem, type Food, type Portion, sevenDayWeightAverage } from "@edo/core";
import type { DiaryMeal, DiaryProgressStore, DiaryStore } from "@edo/storage";
import { randomUUID } from "expo-crypto";
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
import { foodForPackagedProduct } from "./src/barcode";
import { BarcodeEntry, type BarcodeState } from "./src/barcode-entry";
import { CustomFoodList } from "./src/custom-food-list";
import { CustomFoodScreen } from "./src/custom-food-screen";
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
import { openLocalPackagedCache } from "./src/local-packaged-cache";
import { ProgressScreen } from "./src/progress";
import { type ProgressRange, recentWeightEnd, weightWindowStart } from "./src/progress-data";
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
  | ({ kind: "barcode"; state: BarcodeState } & SearchContext)
  | ({ kind: "my-foods" } & SearchContext)
  | ({ kind: "custom-food"; current: Food | null; sourceId: string } & SearchContext)
  | ({ kind: "add"; food: Food; barcode?: BarcodeState; fromCustomFoods?: boolean } & SearchContext)
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

function readWeights(diary: DiaryProgressStore, day: string, days: number, through = day) {
  try {
    return diary.listWeighIns(weightWindowStart(day, days), through);
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
  const packagedCache = useDatabase(openLocalPackagedCache, false);
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
      const { day, occurredAt, utcOffsetMinutes, query, barcode, fromCustomFoods } = route;
      const context = { day, occurredAt, utcOffsetMinutes, query };
      setRoute(
        barcode
          ? { ...context, kind: "barcode", state: barcode }
          : { ...context, kind: fromCustomFoods ? "my-foods" : "search" },
      );
    } else if (
      route.kind === "barcode" ||
      route.kind === "my-foods" ||
      route.kind === "custom-food"
    ) {
      const { day, occurredAt, utcOffsetMinutes, query } = route;
      setRoute({
        kind: route.kind === "custom-food" ? "my-foods" : "search",
        day,
        occurredAt,
        utcOffsetMinutes,
        query,
      });
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
                packagedCache.start();
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
        recent={readWeights(diary, today, 96, recentWeightEnd(today)) ?? []}
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
  const cachedProducts = packagedCache.value === "error" ? null : packagedCache.value?.cache;
  if (route.kind === "barcode") {
    return (
      <BarcodeEntry
        t={t}
        locale={locale}
        date={date}
        today={today}
        diary={diary}
        cache={cachedProducts}
        initial={route.state}
        onBack={goBack}
        onPick={(product, barcode) =>
          setRoute({ ...route, kind: "add", food: foodForPackagedProduct(product), barcode })
        }
      />
    );
  }
  if (route.kind === "my-foods") {
    let foods: Food[] | null = null;
    try {
      foods = diary.listCustomFoods();
    } catch {
      // The library can fail independently of the current diary and bundled catalog.
    }
    return (
      <CustomFoodList
        t={t}
        locale={locale}
        date={date}
        foods={foods}
        onBack={goBack}
        onCreate={() =>
          setRoute({ ...route, kind: "custom-food", current: null, sourceId: randomUUID() })
        }
        onEdit={(current) =>
          setRoute({ ...route, kind: "custom-food", current, sourceId: current.id.sourceId })
        }
        onPick={(food) => setRoute({ ...route, kind: "add", food, fromCustomFoods: true })}
        onRetry={() => setRefresh((revision) => revision + 1)}
      />
    );
  }
  if (route.kind === "custom-food") {
    const { current, sourceId } = route;
    const showLibrary = () => setRoute({ ...route, kind: "my-foods" });
    return (
      <CustomFoodScreen
        language={language}
        locale={locale}
        current={current}
        onBack={goBack}
        onSave={({ name, nutrition }) => {
          diary.saveCustomFood({
            id: { provider: "local", sourceId },
            name,
            nutrition,
            release: null,
            preparation: current?.preparation ?? "unknown",
          });
          showLibrary();
        }}
        onDelete={
          current
            ? () => {
                diary.deleteCustomFood(current.id.sourceId);
                showLibrary();
              }
            : undefined
        }
      />
    );
  }
  if (route.kind === "search") {
    return (
      <SearchScreen
        t={t}
        locale={locale}
        language={language}
        date={date}
        catalog={catalog.value === "error" ? "error" : (catalog.value?.db ?? null)}
        packagedCache={cachedProducts ?? null}
        query={route.query}
        onQuery={(query) => setRoute({ ...route, query })}
        onBarcode={() => {
          Keyboard.dismiss();
          setRoute({ ...route, kind: "barcode", state: { code: "", result: null } });
        }}
        onMyFoods={() => {
          Keyboard.dismiss();
          setRoute({ ...route, kind: "my-foods" });
        }}
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

import {
  type DiaryItem,
  type Food,
  type FoodId,
  foodForRecipe,
  type PackagedFood,
  type Portion,
  type Recipe,
  sevenDayWeightAverage,
} from "@edo/core";
import {
  type DiaryMeal,
  type DiaryProgressStore,
  type DiaryStore,
  mealFromTemplate,
  type SavedMealTemplate,
} from "@edo/storage";
import { fetch } from "expo/fetch";
import { randomUUID } from "expo-crypto";
import { getLocales } from "expo-localization";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  AppState,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { pruneArchiveExports } from "./src/archive-files";
import { ArchiveScreen } from "./src/archive-screen";
import {
  foodForPackagedProduct,
  retainedProducts,
  revalidatePackagedSelection,
  stalePackagedSelection,
} from "./src/barcode";
import { BarcodeEntry, type BarcodeState } from "./src/barcode-entry";
import { packagedCatalogOrigin } from "./src/catalog-origin";
import { CustomFoodList } from "./src/custom-food-list";
import { CustomFoodScreen } from "./src/custom-food-screen";
import {
  addDays,
  diaryDayLimit,
  type EntryTime,
  entryTime,
  foodLibraryEntryTime,
  localDay,
  mondayOf,
  nextMidnight,
  saveFood,
  totalNutrition,
} from "./src/diary-view";
import { FavoriteFoodList } from "./src/favorite-food-list";
import { foodKey } from "./src/favorite-foods";
import { FddbImportScreen } from "./src/fddb-import-screen";
import { FoodDetail } from "./src/food-detail";
import { type HomeTab, HomeTabs } from "./src/home-tabs";
import { openLocalCatalog } from "./src/local-catalog";
import { openLocalDiary } from "./src/local-diary";
import { openLocalPackagedCache } from "./src/local-packaged-cache";
import { type MealTemplateOption, mealTemplateOptions } from "./src/meal-template-form";
import { ProfileScreen } from "./src/profile";
import { ProgressScreen } from "./src/progress";
import { type ProgressRange, recentWeightEnd, weightWindowStart } from "./src/progress-data";
import { RecipeEditor } from "./src/recipe-editor";
import { RecipeList } from "./src/recipe-list";
import { SavedMealEditor, SavedMealList } from "./src/saved-meals";
import { SearchScreen } from "./src/search";
import { appLocale, type Language, strings } from "./src/strings";
import { SyncBlockerNotice, SyncBlockerScreen } from "./src/sync-blocker-screen";
import { syncBlockerNotice } from "./src/sync-blockers";
import { TargetsScreen } from "./src/targets-screen";
import { TodayScreen } from "./src/today";
import { DetailHeader, Notice, showDay, styles } from "./src/ui";
import { useDatabase } from "./src/use-database";
import { WeighInScreen } from "./src/weigh-in";

type LocalDiary = Awaited<ReturnType<typeof openLocalDiary>>;
type SearchContext = EntryTime & {
  query: string;
  fromFoodsTab?: boolean;
  returnToTab?: HomeTab;
};
type FoodSelection = SearchContext & { food: Food; fromCustomFoods?: boolean };
type DeviceContext = { today: string; language: Language; locale: string };
type SettingsParent = "progress" | "profile";
type Route =
  | { kind: "diary" }
  | { kind: "sync-blockers"; returnTo: "diary" | "progress" }
  | { kind: "progress" }
  | { kind: "profile" }
  | { kind: "weigh-in" }
  | { kind: "targets"; returnTo: SettingsParent }
  | { kind: "save-meal-template"; day: string; templateId: string; options: MealTemplateOption[] }
  | { kind: "archive"; returnTo: SettingsParent }
  | { kind: "fddb-import"; returnTo: SettingsParent }
  | ({ kind: "search" } & SearchContext)
  | ({ kind: "barcode"; state: BarcodeState } & SearchContext)
  | ({ kind: "my-foods" } & SearchContext)
  | ({ kind: "custom-food"; current: Food | null; sourceId: string } & SearchContext)
  | ({ kind: "recipe"; current: Recipe | null; recipeId: string } & SearchContext)
  | ({ kind: "add"; barcode?: BarcodeState } & FoodSelection)
  | ({ kind: "revalidate-packaged"; product: PackagedFood } & FoodSelection)
  | { kind: "edit"; day: string; mealId: string; itemId: string; item: DiaryItem };

function useDeviceContext(): DeviceContext {
  const [today, setToday] = useState(() => localDay(new Date()));
  const [locale, setLocale] = useState(() => appLocale(getLocales()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function refresh() {
      clearTimeout(timer);
      const now = new Date();
      pruneArchiveExports(now.getTime());
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
  const [feedback, setFeedback] = useState<{
    day: string;
    kind: "saved" | "updated" | "loggedMealTemplateSaved";
  } | null>(null);
  const catalog = useDatabase(openLocalCatalog, false);
  const packagedCache = useDatabase(openLocalPackagedCache, false);
  const t = strings[language];
  const { diary } = connection;
  const cachedProducts = packagedCache.value === "error" ? null : packagedCache.value?.cache;
  const reviewFrom = route.kind === "diary" || route.kind === "progress" ? route.kind : null;
  const syncNoticeState = useMemo(
    () => (reviewFrom ? syncBlockerNotice(diary.sync.journal) : "clear"),
    [diary, reviewFrom],
  );
  const syncNotice =
    reviewFrom && syncNoticeState !== "clear" ? (
      <SyncBlockerNotice
        state={syncNoticeState}
        language={language}
        onOpen={() => setRoute({ kind: "sync-blockers", returnTo: reviewFrom })}
      />
    ) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Favorite writes invalidate the SQLite read.
  const favorites = useMemo(() => {
    if (route.kind !== "my-foods" && route.kind !== "add") return null;
    try {
      return diary.listFavorites();
    } catch {
      return null;
    }
  }, [diary, route.kind, refresh]);
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

  useEffect(() => {
    if (route.kind !== "revalidate-packaged") return;
    const controller = new AbortController();
    const { product, ...selection } = route;
    void revalidatePackagedSelection(product, {
      origin: packagedCatalogOrigin,
      cache: cachedProducts ?? null,
      keep: () => retainedProducts(diary, today),
      request: fetch,
      signal: controller.signal,
    })
      .catch(() => null)
      .then((food) => {
        if (controller.signal.aborted) return;
        setRoute((current) =>
          current === route ? { ...selection, kind: "add", food: food ?? route.food } : current,
        );
      });
    return () => controller.abort();
  }, [route, cachedProducts, diary, today]);

  function pickFood(context: SearchContext, food: Food, fromCustomFoods?: boolean) {
    Keyboard.dismiss();
    const selection = {
      ...context,
      ...foodLibraryEntryTime(context, context.fromFoodsTab === true, new Date()),
      food,
      fromCustomFoods,
    };
    const product =
      packagedCatalogOrigin && stalePackagedSelection(food, cachedProducts, Date.now());
    setRoute(
      product
        ? { ...selection, kind: "revalidate-packaged", product }
        : { ...selection, kind: "add" },
    );
  }

  function goBack() {
    if (route.kind === "diary") return false;
    Keyboard.dismiss();
    if (route.kind === "add" || route.kind === "revalidate-packaged") {
      const {
        day,
        occurredAt,
        utcOffsetMinutes,
        query,
        fromCustomFoods,
        fromFoodsTab,
        returnToTab,
      } = route;
      const barcode = route.kind === "add" ? route.barcode : undefined;
      const context = { day, occurredAt, utcOffsetMinutes, query, fromFoodsTab, returnToTab };
      setRoute(
        barcode
          ? { ...context, kind: "barcode", state: barcode }
          : { ...context, kind: fromCustomFoods ? "my-foods" : "search" },
      );
    } else if (route.kind === "my-foods" && route.fromFoodsTab) {
      setRoute({ kind: "diary" });
    } else if (route.kind === "search" && route.returnToTab) {
      if (route.returnToTab === "my-foods") startFoodFlow("my-foods");
      else setRoute({ kind: route.returnToTab });
    } else if (
      route.kind === "barcode" ||
      route.kind === "my-foods" ||
      route.kind === "custom-food" ||
      route.kind === "recipe"
    ) {
      const { day, occurredAt, utcOffsetMinutes, query, fromFoodsTab, returnToTab } = route;
      setRoute({
        kind: route.kind === "custom-food" || route.kind === "recipe" ? "my-foods" : "search",
        day,
        occurredAt,
        utcOffsetMinutes,
        query,
        fromFoodsTab,
        returnToTab,
      });
    } else if (route.kind === "fddb-import") {
      setRoute({ kind: "archive", returnTo: route.returnTo });
    } else if (route.kind === "sync-blockers") {
      setRoute({ kind: route.returnTo });
    } else if (route.kind === "targets" || route.kind === "archive") {
      setRoute({ kind: route.returnTo });
    } else if (route.kind === "weigh-in") {
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

  function startFoodFlow(kind: "search" | "my-foods", returnToTab?: HomeTab) {
    catalog.start();
    packagedCache.start();
    setFeedback(null);
    const loggingDay = kind === "search" && route.kind === "diary" ? selectedDay : null;
    const context = { ...entryTime(loggingDay, new Date()), query: "" };
    setRoute(
      kind === "my-foods"
        ? { ...context, kind, fromFoodsTab: true }
        : { ...context, kind, returnToTab },
    );
  }

  function homeTabs(active: HomeTab, screen: ReactNode) {
    return (
      <>
        <View style={styles.stretch}>{screen}</View>
        <HomeTabs
          active={active}
          t={t}
          onLog={
            route.kind === "diary" && day > today
              ? undefined
              : () => startFoodFlow("search", active)
          }
          onTab={(tab) => {
            if (tab === active) return;
            if (tab === "my-foods") {
              startFoodFlow(tab);
            } else {
              if (tab === "progress") setSavedWeightDay(null);
              setRoute({ kind: tab });
            }
          }}
        />
      </>
    );
  }

  if (route.kind === "diary") {
    return homeTabs(
      "diary",
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
        syncNotice={syncNotice}
        onDay={chooseDay}
        onWeek={(offset) => {
          const next = addDays(day, offset);
          const withinDiary = next <= lastDay;
          chooseDay(withinDiary ? next : lastDay);
        }}
        onEdit={(mealId, itemId) => {
          const meal = meals?.find((entry) => entry.id === mealId);
          const item = meal?.items.find((entry) => entry.id === itemId);
          if (meal && item) {
            setFeedback(null);
            setRoute({ kind: "edit", day: meal.localDay, mealId, itemId, item });
          }
        }}
        onSaveMeal={(meal) =>
          setRoute({
            kind: "save-meal-template",
            day: meal.localDay,
            templateId: randomUUID(),
            options: mealTemplateOptions(meal, meals ?? []),
          })
        }
        onRetry={() => setRefresh((revision) => revision + 1)}
      />,
    );
  }

  if (route.kind === "sync-blockers") {
    return (
      <SyncBlockerScreen
        journal={diary.sync.journal}
        language={language}
        locale={locale}
        onBack={goBack}
      />
    );
  }

  if (route.kind === "progress") {
    return homeTabs(
      "progress",
      <ProgressScreen
        diary={diary}
        today={today}
        locale={locale}
        t={t}
        range={progressRange}
        savedDay={savedWeightDay}
        syncNotice={syncNotice}
        onRange={setProgressRange}
        onBack={goBack}
        onTargets={() => setRoute({ kind: "targets", returnTo: "progress" })}
        onArchive={() => setRoute({ kind: "archive", returnTo: "progress" })}
        onWeight={() => {
          setSavedWeightDay(null);
          setRoute({ kind: "weigh-in" });
        }}
      />,
    );
  }
  if (route.kind === "profile") {
    return homeTabs(
      "profile",
      <ProfileScreen
        t={t}
        onTargets={() => setRoute({ kind: "targets", returnTo: "profile" })}
        onDiaryFiles={() => setRoute({ kind: "archive", returnTo: "profile" })}
      />,
    );
  }
  if (route.kind === "archive") {
    return (
      <ArchiveScreen
        t={t}
        archive={diary}
        onBack={goBack}
        onFddbImport={() => setRoute({ kind: "fddb-import", returnTo: route.returnTo })}
      />
    );
  }
  if (route.kind === "fddb-import") {
    return (
      <FddbImportScreen
        t={t}
        diary={diary}
        onBack={goBack}
        onImported={() => setRefresh((revision) => revision + 1)}
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
          setRoute({ kind: route.returnTo });
        }}
      />
    );
  }

  const displayDay = route.kind === "my-foods" && route.fromFoodsTab ? today : route.day;
  const date = showDay(displayDay, locale, today);
  if (route.kind === "save-meal-template") {
    return (
      <SavedMealEditor
        t={t}
        locale={locale}
        date={date}
        options={route.options}
        onBack={goBack}
        onSave={(template) => {
          diary.saveMealTemplate({ ...template, id: route.templateId });
          setFeedback({ day: route.day, kind: "loggedMealTemplateSaved" });
          setRoute({ kind: "diary" });
        }}
      />
    );
  }
  if (route.kind === "revalidate-packaged") {
    const { product: _product, ...selection } = route;
    return (
      <>
        <DetailHeader title={t.addFood} subtitle={date} back={t.back} onBack={goBack} />
        <Notice
          text={t.checkingPackagedFood}
          pending
          action={{
            label: t.useCachedFood,
            onPress: () => setRoute({ ...selection, kind: "add" }),
          }}
        />
      </>
    );
  }
  function setFavorite(id: FoodId, enabled: boolean) {
    diary.setFavorite(id, enabled);
    setRefresh((revision) => revision + 1);
    if (id.provider === "open-food-facts" && cachedProducts) {
      try {
        cachedProducts.prune(retainedProducts(diary, today));
      } catch {
        // A favorite is saved even if its disposable cache failed to prune.
      }
    }
  }
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
    let recipes: Recipe[] | null = null;
    try {
      recipes = diary.listRecipes();
    } catch {
      // An unavailable recipe collection should leave custom foods usable.
    }
    let templates: SavedMealTemplate[] | null = null;
    try {
      templates = diary.listMealTemplates();
    } catch {
      // An unavailable template collection should leave other library items usable.
    }
    const screen = (
      <CustomFoodList
        t={t}
        locale={locale}
        date={date}
        foods={foods}
        favorites={
          favorites === null ? (
            <Notice
              text={t.favoriteListError}
              action={{ label: t.retry, onPress: () => setRefresh((revision) => revision + 1) }}
            />
          ) : favorites.length ? (
            <FavoriteFoodList
              t={t}
              ids={favorites}
              localFoods={foods}
              recipeFoods={recipes?.map(foodForRecipe) ?? null}
              catalog={catalog.value === "error" ? "error" : (catalog.value?.db ?? null)}
              cache={packagedCache.value === "error" ? "error" : (cachedProducts ?? null)}
              diary={diary}
              today={today}
              language={language}
              onPick={(food) => pickFood(route, food, true)}
              onRemove={(id) => setFavorite(id, false)}
              onRetry={(provider) => {
                if (provider === "bls") catalog.retry();
                if (provider === "open-food-facts") packagedCache.retry();
                setRefresh((revision) => revision + 1);
              }}
            />
          ) : undefined
        }
        savedMeals={
          <SavedMealList
            t={t}
            locale={locale}
            templates={templates}
            onRetry={() => setRefresh((revision) => revision + 1)}
            onLog={(template) => {
              const { day, occurredAt, utcOffsetMinutes } = foodLibraryEntryTime(
                route,
                route.fromFoodsTab === true,
                new Date(),
              );
              const meal = mealFromTemplate(
                template,
                {
                  id: randomUUID(),
                  localDay: day,
                  occurredAt,
                  utcOffsetMinutes,
                },
                randomUUID,
              );
              diary.saveMeal(meal);
              setSelectedDay(meal.localDay === localDay(new Date()) ? null : meal.localDay);
              setFeedback({ day: meal.localDay, kind: "saved" });
              setRefresh((revision) => revision + 1);
              setRoute({ kind: "diary" });
            }}
          />
        }
        recipes={
          <RecipeList
            t={t}
            locale={locale}
            recipes={recipes}
            onCreate={() =>
              setRoute({ ...route, kind: "recipe", current: null, recipeId: randomUUID() })
            }
            onEdit={(current) =>
              setRoute({ ...route, kind: "recipe", current, recipeId: current.id })
            }
            onRetry={() => setRefresh((revision) => revision + 1)}
            onPick={(recipe) => pickFood(route, foodForRecipe(recipe), true)}
          />
        }
        onBack={goBack}
        onCreate={() =>
          setRoute({ ...route, kind: "custom-food", current: null, sourceId: randomUUID() })
        }
        onEdit={(current) =>
          setRoute({ ...route, kind: "custom-food", current, sourceId: current.id.sourceId })
        }
        onPick={(food) => pickFood(route, food, true)}
        onRetry={() => setRefresh((revision) => revision + 1)}
      />
    );
    return route.fromFoodsTab ? homeTabs("my-foods", screen) : screen;
  }
  if (route.kind === "recipe") {
    let customFoods: Food[] = [];
    try {
      customFoods = diary.listCustomFoods();
    } catch {
      // The editor can still add ingredients from the local catalog.
    }
    return (
      <RecipeEditor
        language={language}
        locale={locale}
        current={route.current}
        customFoods={customFoods}
        catalog={catalog.value === "error" ? "error" : (catalog.value?.db ?? null)}
        packagedCache={cachedProducts ?? null}
        refreshIngredient={(food, signal) => {
          const product =
            packagedCatalogOrigin && stalePackagedSelection(food, cachedProducts, Date.now());
          return product
            ? revalidatePackagedSelection(product, {
                origin: packagedCatalogOrigin,
                cache: cachedProducts ?? null,
                keep: () => retainedProducts(diary, today),
                request: fetch,
                signal,
              })
            : null;
        }}
        onCatalogRetry={catalog.retry}
        newItemId={randomUUID}
        onBack={goBack}
        onSave={(draft) => {
          diary.saveRecipe({ ...draft, id: route.recipeId });
          setRoute({ ...route, kind: "my-foods" });
        }}
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
        onPick={(food) => pickFood(route, food)}
      />
    );
  }

  const food = route.kind === "add" ? route.food : route.item.food;
  const selected = favorites?.some((id) => foodKey(id) === foodKey(food.id)) ?? false;
  return (
    <FoodDetail
      t={t}
      locale={locale}
      date={date}
      food={food}
      favorite={
        route.kind === "add"
          ? favorites
            ? { selected, toggle: () => setFavorite(food.id, !selected) }
            : { retry: () => setRefresh((revision) => revision + 1) }
          : undefined
      }
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

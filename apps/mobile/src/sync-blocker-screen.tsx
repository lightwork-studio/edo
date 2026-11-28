import type { DiaryItem } from "@edo/core";
import { type ComponentRef, useRef, useState } from "react";
import { AccessibilityInfo, Pressable, ScrollView, Text, View } from "react-native";
import { type Language, strings } from "./strings";
import {
  type BlockerJournal,
  type MealReviewSide,
  type RecipeReviewSide,
  readSyncBlocker,
  reviewItemPage,
  reviewQuantityFormatter,
  type syncBlockerNotice,
  type WeighInReviewSide,
} from "./sync-blockers";
import { DetailHeader, macros, Notice, styles } from "./ui";

const gregorianCutoverDay = "1582-10-15";
const gregorianCutoverTime = Date.parse(`${gregorianCutoverDay}T00:00:00.000Z`);
const reviewNutrients = [...macros, { label: "fibre", nutrient: "fiberG" }] as const;

const copy = {
  en: {
    title: "Sync issues",
    waiting: "A saved change needs sync review.",
    unreadable: "Couldn’t read saved sync issues.",
    empty: "There are no saved sync issues.",
    changed: "The saved sync issues changed. Start the review again.",
    open: "View sync issues",
    next: "Next issue",
    restart: "Start again",
    position: (number: number) => `Issue ${number}`,
    record: "Saved record",
    put: "The phone’s latest saved action is an edit.",
    delete: "The phone’s latest saved action is a deletion.",
    weighIn: {
      phone: "Pending phone change",
      account: "Saved account copy",
      localDay: "Diary day",
      instant: "Recorded time",
      deleted: "Deleted",
      unavailable: "Weigh-in values unavailable",
      unknown: "Current account value unknown",
    },
    meal: {
      unavailable: "Meal contents unavailable",
      empty: "No items in this meal.",
      offset: "Recorded UTC offset",
      missingOffset: "Offset unavailable",
    },
    recipe: {
      unavailable: "Recipe contents unavailable",
      cookedWeight: "Cooked weight",
      unknownWeight: "Cooked weight unknown",
      ingredients: "Ingredients",
    },
    items: {
      previousPage: "Previous items",
      nextPage: "Next items",
      itemRange: (first: number, last: number, total: number) =>
        `Items ${first}–${last} of ${total}`,
      unknownEnergy: "Energy unknown",
      unknownNutrient: "unknown",
    },
    kinds: {
      meal: "Meal",
      "custom-food": "Custom food",
      recipe: "Recipe",
      "meal-template": "Saved meal",
      favorite: "Favorite",
      "weigh-in": "Weigh-in",
      "nutrition-target": "Nutrition targets",
    } as Record<string, string>,
    reasons: {
      stale: "The server reported a newer version when it received the previous submission.",
      deleted: "The server reported a deletion when it received the previous submission.",
      exists: "The server reported that this record already existed.",
      "invalid-content": "The server refused the previous submission.",
      "submission-reused":
        "The server already received a different change with this submission ID.",
    },
  },
  de: {
    title: "Synchronisierungsprobleme",
    waiting: "Eine gespeicherte Änderung muss vor der Synchronisierung geprüft werden.",
    unreadable: "Gespeicherte Synchronisierungsprobleme konnten nicht gelesen werden.",
    empty: "Es gibt keine gespeicherten Synchronisierungsprobleme.",
    changed:
      "Die gespeicherten Synchronisierungsprobleme haben sich geändert. Starte die Prüfung neu.",
    open: "Synchronisierungsprobleme ansehen",
    next: "Nächstes Problem",
    restart: "Von vorn beginnen",
    position: (number: number) => `Problem ${number}`,
    record: "Gespeicherter Eintrag",
    put: "Die zuletzt auf dem Gerät gespeicherte Aktion ist eine Änderung.",
    delete: "Die zuletzt auf dem Gerät gespeicherte Aktion ist eine Löschung.",
    weighIn: {
      phone: "Ausstehende Änderung auf dem Gerät",
      account: "Gespeicherte Kontokopie",
      localDay: "Tagebuchdatum",
      instant: "Erfasster Zeitpunkt",
      deleted: "Gelöscht",
      unavailable: "Gewichtsdaten nicht verfügbar",
      unknown: "Aktueller Kontowert unbekannt",
    },
    meal: {
      unavailable: "Mahlzeit nicht verfügbar",
      empty: "Diese Mahlzeit enthält keine Einträge.",
      offset: "Erfasste UTC-Abweichung",
      missingOffset: "UTC-Abweichung nicht verfügbar",
    },
    recipe: {
      unavailable: "Rezept nicht verfügbar",
      cookedWeight: "Gewicht nach dem Kochen",
      unknownWeight: "Gewicht nach dem Kochen unbekannt",
      ingredients: "Zutaten",
    },
    items: {
      previousPage: "Vorherige Einträge",
      nextPage: "Nächste Einträge",
      itemRange: (first: number, last: number, total: number) =>
        `Einträge ${first}–${last} von ${total}`,
      unknownEnergy: "Energie unbekannt",
      unknownNutrient: "unbekannt",
    },
    kinds: {
      meal: "Mahlzeit",
      "custom-food": "Eigenes Lebensmittel",
      recipe: "Rezept",
      "meal-template": "Gespeicherte Mahlzeit",
      favorite: "Favorit",
      "weigh-in": "Gewichtseintrag",
      "nutrition-target": "Ernährungsziele",
    } as Record<string, string>,
    reasons: {
      stale: "Bei der letzten Übermittlung meldete der Server eine neuere Version.",
      deleted: "Bei der letzten Übermittlung meldete der Server eine Löschung.",
      exists: "Der Server meldete, dass dieser Eintrag bereits vorhanden war.",
      "invalid-content": "Der Server hat die vorherige Übermittlung abgelehnt.",
      "submission-reused":
        "Der Server hat bereits eine andere Änderung mit derselben Übermittlungs-ID erhalten.",
    },
  },
} as const;

export function SyncBlockerNotice({
  state,
  language,
  onOpen,
}: {
  state: ReturnType<typeof syncBlockerNotice>;
  language: Language;
  onOpen: () => void;
}) {
  if (state === "clear") return null;
  const words = copy[language];
  return (
    <Notice
      text={state === "error" ? words.unreadable : words.waiting}
      action={{ label: words.open, onPress: onOpen }}
    />
  );
}

export function SyncBlockerScreen({
  journal,
  language,
  locale,
  onBack,
}: {
  journal: BlockerJournal;
  language: Language;
  locale: string;
  onBack: () => void;
}) {
  const words = copy[language];
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [{ issue, position, generation }, setReview] = useState(() => ({
    issue: readSyncBlocker(journal, null),
    position: 1,
    generation: 0,
  }));
  function restart() {
    const first = readSyncBlocker(journal, null);
    scroll.current?.scrollTo({ y: 0, animated: false });
    setReview({ issue: first, position: 1, generation: generation + 1 });
    if (first.state !== "empty") AccessibilityInfo.announceForAccessibility(words.position(1));
  }
  function next() {
    if (!issue.next) return;
    const nextPosition = position + 1;
    scroll.current?.scrollTo({ y: 0, animated: false });
    setReview({
      issue: readSyncBlocker(journal, issue.next),
      position: nextPosition,
      generation,
    });
    AccessibilityInfo.announceForAccessibility(words.position(nextPosition));
  }
  return (
    <>
      <DetailHeader title={words.title} back={strings[language].back} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content} ref={scroll}>
        {issue.state === "blocked" ? (
          <View style={styles.card}>
            <Text style={styles.meta}>{words.position(position)}</Text>
            <Text accessibilityRole="header" style={styles.title}>
              {(Object.hasOwn(words.kinds, issue.kind) && words.kinds[issue.kind]) || words.record}
            </Text>
            <Text style={styles.body}>{words.reasons[issue.reason]}</Text>
            {issue.weighIn ? (
              <>
                <WeighInSide
                  title={words.weighIn.phone}
                  side={issue.weighIn.phone}
                  locale={locale}
                  words={words.weighIn}
                />
                <WeighInSide
                  title={words.weighIn.account}
                  side={issue.weighIn.account}
                  locale={locale}
                  words={words.weighIn}
                />
              </>
            ) : issue.meal ? (
              <>
                <MealSide
                  key={`${generation}-${position}-phone`}
                  title={words.weighIn.phone}
                  side={issue.meal.phone}
                  locale={locale}
                  language={language}
                />
                <MealSide
                  key={`${generation}-${position}-account`}
                  title={words.weighIn.account}
                  side={issue.meal.account}
                  locale={locale}
                  language={language}
                />
              </>
            ) : issue.recipe ? (
              <>
                <RecipeSide
                  key={`${generation}-${position}-phone`}
                  title={words.weighIn.phone}
                  side={issue.recipe.phone}
                  locale={locale}
                  language={language}
                />
                <RecipeSide
                  key={`${generation}-${position}-account`}
                  title={words.weighIn.account}
                  side={issue.recipe.account}
                  locale={locale}
                  language={language}
                />
              </>
            ) : (
              <Text style={styles.meta}>{words[issue.operation]}</Text>
            )}
            <Pressable accessibilityRole="button" onPress={restart} style={styles.action}>
              <Text style={styles.actionText}>{words.restart}</Text>
            </Pressable>
          </View>
        ) : (
          <Notice
            text={issue.state === "error" ? words.unreadable : words[issue.state]}
            action={{ label: strings[language].retry, onPress: restart }}
          />
        )}
        {issue.next && (
          <Pressable accessibilityRole="button" onPress={next} style={styles.action}>
            <Text style={styles.actionText}>{words.next}</Text>
          </Pressable>
        )}
      </ScrollView>
    </>
  );
}

function WeighInSide({
  title,
  side,
  locale,
  words,
}: {
  title: string;
  side: WeighInReviewSide;
  locale: string;
  words: (typeof copy)[Language]["weighIn"];
}) {
  const formatQuantity = reviewQuantityFormatter(locale);
  return (
    <View>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {side.state === "live" ? (
        <>
          <Text style={[styles.body, styles.numbers]}>{formatQuantity(side.kg)} kg</Text>
          <CapturedTime
            localDay={side.localDay}
            occurredAt={side.occurredAt}
            locale={locale}
            words={words}
          />
        </>
      ) : (
        <Text style={styles.meta}>{words[side.state]}</Text>
      )}
    </View>
  );
}

function CapturedTime({
  localDay,
  occurredAt,
  locale,
  words,
}: {
  localDay: string;
  occurredAt: number;
  locale: string;
  words: Pick<(typeof copy)[Language]["weighIn"], "localDay" | "instant">;
}) {
  return (
    <>
      <Text style={styles.meta}>{words.localDay}</Text>
      <Text style={styles.body}>
        {localDay < gregorianCutoverDay
          ? localDay
          : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
              new Date(`${localDay}T00:00:00.000Z`),
            )}
      </Text>
      <Text style={styles.meta}>{words.instant}</Text>
      <Text style={styles.body}>
        {occurredAt < gregorianCutoverTime || occurredAt % 1000 !== 0
          ? new Date(occurredAt).toISOString()
          : new Intl.DateTimeFormat(locale, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
              timeZone: "UTC",
              timeZoneName: "short",
            }).format(occurredAt)}
      </Text>
    </>
  );
}

function MealSide({
  title,
  side,
  locale,
  language,
}: {
  title: string;
  side: MealReviewSide;
  locale: string;
  language: Language;
}) {
  const words = copy[language];
  const heading = (
    <Text accessibilityRole="header" style={styles.title}>
      {title}
    </Text>
  );
  if (side.state !== "live") {
    return (
      <View>
        {heading}
        <Text style={styles.meta}>
          {side.state === "unavailable" ? words.meal.unavailable : words.weighIn[side.state]}
        </Text>
      </View>
    );
  }

  const { meal } = side;
  const offset = meal.utcOffsetMinutes;
  return (
    <View>
      {heading}
      <CapturedTime
        localDay={meal.localDay}
        occurredAt={meal.occurredAt}
        locale={locale}
        words={words.weighIn}
      />
      <Text style={styles.meta}>{words.meal.offset}</Text>
      <Text style={styles.body}>
        {offset === undefined ? words.meal.missingOffset : formatUtcOffset(offset)}
      </Text>
      {meal.items.length ? (
        <CapturedItems title={title} entries={meal.items} locale={locale} language={language} />
      ) : (
        <Text style={styles.meta}>{words.meal.empty}</Text>
      )}
    </View>
  );
}

function RecipeSide({
  title,
  side,
  locale,
  language,
}: {
  title: string;
  side: RecipeReviewSide;
  locale: string;
  language: Language;
}) {
  const words = copy[language];
  const heading = (
    <Text accessibilityRole="header" style={styles.title}>
      {title}
    </Text>
  );
  if (side.state !== "live") {
    return (
      <View>
        {heading}
        <Text style={styles.meta}>
          {side.state === "unavailable" ? words.recipe.unavailable : words.weighIn[side.state]}
        </Text>
      </View>
    );
  }
  const { recipe } = side;
  const formatQuantity = reviewQuantityFormatter(locale);
  return (
    <View>
      {heading}
      <Text style={styles.body}>{recipe.name}</Text>
      <Text style={styles.meta}>
        {strings[language].recipeServings(formatQuantity(recipe.servings), recipe.servings)}
      </Text>
      <Text style={styles.meta}>{words.recipe.cookedWeight}</Text>
      <Text style={styles.body}>
        {recipe.cookedWeightG === undefined
          ? words.recipe.unknownWeight
          : `${formatQuantity(recipe.cookedWeightG)} g`}
      </Text>
      <Text style={styles.meta}>{words.recipe.ingredients}</Text>
      <CapturedItems
        title={title}
        entries={recipe.ingredients}
        locale={locale}
        language={language}
      />
    </View>
  );
}

function CapturedItems({
  title,
  entries,
  locale,
  language,
}: {
  title: string;
  entries: readonly DiaryItem[];
  locale: string;
  language: Language;
}) {
  const words = copy[language].items;
  const [page, setPage] = useState(0);
  const formatQuantity = reviewQuantityFormatter(locale);
  const { items, total, start, end } = reviewItemPage(entries, page);
  function changePage(next: number) {
    setPage(next);
    const nextPage = reviewItemPage(entries, next);
    AccessibilityInfo.announceForAccessibility(
      `${title}. ${words.itemRange(nextPage.start + 1, nextPage.end, total)}`,
    );
  }
  return (
    <>
      {(start > 0 || end < total) && (
        <>
          <Text style={styles.meta}>{words.itemRange(start + 1, end, total)}</Text>
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: start === 0 }}
              accessibilityLabel={`${title}. ${words.previousPage}`}
              disabled={start === 0}
              onPress={() => changePage(page - 1)}
              style={[styles.action, styles.stretch, start === 0 && styles.faded]}
            >
              <Text style={styles.actionText}>{words.previousPage}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: end === total }}
              accessibilityLabel={`${title}. ${words.nextPage}`}
              disabled={end === total}
              onPress={() => changePage(page + 1)}
              style={[styles.action, styles.stretch, end === total && styles.faded]}
            >
              <Text style={styles.actionText}>{words.nextPage}</Text>
            </Pressable>
          </View>
        </>
      )}
      {items.map(({ id, food, portion, nutrients }) => (
        <View key={id}>
          <Text style={styles.body}>{food.name}</Text>
          <Text style={[styles.meta, styles.numbers]}>
            {formatQuantity(portion.amount)}{" "}
            {portion.unit === "portion" ? strings[language].portion : portion.unit}
            {" · "}
            {nutrients.kcal === null
              ? words.unknownEnergy
              : `${formatQuantity(nutrients.kcal)} kcal`}
          </Text>
          <Text style={styles.meta}>
            {reviewNutrients
              .map(({ label, nutrient }) => {
                const value = nutrients[nutrient];
                const amount =
                  value === null ? words.unknownNutrient : `${formatQuantity(value)} g`;
                return `${strings[language][label]} ${amount}`;
              })
              .join(" · ")}
          </Text>
        </View>
      ))}
    </>
  );
}

function formatUtcOffset(offset: number): string {
  const minutes = Math.abs(offset);
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  return `UTC${offset < 0 ? "-" : "+"}${hours}:${String(minutes % 60).padStart(2, "0")}`;
}

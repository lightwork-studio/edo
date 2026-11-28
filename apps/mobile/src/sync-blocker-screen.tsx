import { type ComponentRef, useRef, useState } from "react";
import { AccessibilityInfo, Pressable, ScrollView, Text, View } from "react-native";
import { type Language, strings } from "./strings";
import {
  type BlockerJournal,
  readSyncBlocker,
  type syncBlockerNotice,
  type WeighInReviewSide,
} from "./sync-blockers";
import { DetailHeader, Notice, styles } from "./ui";

const gregorianCutoverDay = "1582-10-15";
const gregorianCutoverTime = Date.parse(`${gregorianCutoverDay}T00:00:00.000Z`);

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
  const [{ issue, position }, setReview] = useState(() => ({
    issue: readSyncBlocker(journal, null),
    position: 1,
  }));
  function restart() {
    const first = readSyncBlocker(journal, null);
    scroll.current?.scrollTo({ y: 0, animated: false });
    setReview({ issue: first, position: 1 });
    if (first.state !== "empty") AccessibilityInfo.announceForAccessibility(words.position(1));
  }
  function next() {
    if (!issue.next) return;
    const nextPosition = position + 1;
    scroll.current?.scrollTo({ y: 0, animated: false });
    setReview({ issue: readSyncBlocker(journal, issue.next), position: nextPosition });
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
  const recorded = side.state === "live" ? new Date(side.occurredAt) : null;
  const decimalSeparator = new Intl.NumberFormat(locale).format(1.1)[1] ?? ".";
  return (
    <View>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {side.state === "live" ? (
        <>
          <Text style={[styles.body, styles.numbers]}>
            {side.kg.toString().replace(".", decimalSeparator)} kg
          </Text>
          <Text style={styles.meta}>{words.localDay}</Text>
          <Text style={styles.body}>
            {side.localDay < gregorianCutoverDay
              ? side.localDay
              : new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeZone: "UTC",
                }).format(new Date(`${side.localDay}T00:00:00.000Z`))}
          </Text>
          <Text style={styles.meta}>{words.instant}</Text>
          <Text style={styles.body}>
            {recorded && (side.occurredAt < gregorianCutoverTime || side.occurredAt % 1000 !== 0)
              ? recorded.toISOString()
              : new Intl.DateTimeFormat(locale, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  second: "2-digit",
                  timeZone: "UTC",
                  timeZoneName: "short",
                }).format(side.occurredAt)}
          </Text>
        </>
      ) : (
        <Text style={styles.meta}>{words[side.state]}</Text>
      )}
    </View>
  );
}

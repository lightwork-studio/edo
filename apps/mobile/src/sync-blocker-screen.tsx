import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { type Language, strings } from "./strings";
import { type BlockerJournal, readSyncBlocker, type syncBlockerNotice } from "./sync-blockers";
import { DetailHeader, Notice, styles } from "./ui";

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
    record: "Saved record",
    put: "The phone has a saved edit waiting to sync.",
    delete: "The phone has a saved deletion waiting to sync.",
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
      stale: "The server received a newer version of this record.",
      deleted: "The server has a deletion for this record.",
      exists: "The server already has a record with this identity.",
      "invalid-content": "The server refused this change.",
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
    record: "Gespeicherter Eintrag",
    put: "Auf dem Gerät wartet eine gespeicherte Änderung auf die Synchronisierung.",
    delete: "Auf dem Gerät wartet eine gespeicherte Löschung auf die Synchronisierung.",
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
      stale: "Auf dem Server liegt eine neuere Version dieses Eintrags vor.",
      deleted: "Auf dem Server ist dieser Eintrag als gelöscht gespeichert.",
      exists: "Auf dem Server liegt bereits ein Eintrag mit derselben ID vor.",
      "invalid-content": "Der Server hat diese Änderung abgelehnt.",
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
  onBack,
}: {
  journal: BlockerJournal;
  language: Language;
  onBack: () => void;
}) {
  const words = copy[language];
  const [issue, setIssue] = useState(() => readSyncBlocker(journal, null));
  function restart() {
    setIssue(readSyncBlocker(journal, null));
  }
  return (
    <>
      <DetailHeader title={words.title} back={strings[language].back} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content}>
        {issue.state === "blocked" ? (
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.title}>
              {(Object.hasOwn(words.kinds, issue.kind) && words.kinds[issue.kind]) || words.record}
            </Text>
            <Text style={styles.body}>{words.reasons[issue.reason]}</Text>
            <Text style={styles.meta}>{words[issue.operation]}</Text>
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
          <Pressable
            accessibilityRole="button"
            onPress={() => setIssue(readSyncBlocker(journal, issue.next))}
            style={styles.action}
          >
            <Text style={styles.actionText}>{words.next}</Text>
          </Pressable>
        )}
      </ScrollView>
    </>
  );
}

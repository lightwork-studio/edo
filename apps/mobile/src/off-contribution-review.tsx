import type { OffContributionProduct } from "@edo/storage";
import { useEffect, useState } from "react";
import { Keyboard, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { openLocalOffContributionQueue } from "./local-off-contribution-queue";
import type { Strings } from "./strings";
import { colors, DetailHeader, Notice, PrimaryButton, styles } from "./ui";

const copy = {
  en: {
    title: "Open Food Facts draft",
    name: "Product name",
    brand: "Brand (optional)",
    quantity: "Package quantity (optional)",
    language: "Package language code",
    review: "Review product",
    queue: "Save draft on this device",
    saved: "Product draft saved on this device.",
    repeated: "This product draft is already saved.",
    different:
      "A different draft for this barcode is already saved. The earlier draft is still queued.",
    loading: "Opening product drafts…",
    openFailed: "Couldn’t open product drafts. Go back and try again.",
    invalid: "Enter a product name and a two-letter package language code.",
    saveFailed: "Couldn’t save the draft. Try again.",
  },
  de: {
    title: "Entwurf für Open Food Facts",
    name: "Produktname",
    brand: "Marke (optional)",
    quantity: "Packungsmenge (optional)",
    language: "Sprachcode der Verpackung",
    review: "Produkt prüfen",
    queue: "Entwurf auf diesem Gerät speichern",
    saved: "Der Produktentwurf wurde auf diesem Gerät gespeichert.",
    repeated: "Dieser Produktentwurf ist bereits gespeichert.",
    different:
      "Für diesen Barcode ist bereits ein anderer Entwurf gespeichert. Der frühere Entwurf bleibt in der Warteschlange.",
    loading: "Produktentwürfe werden geöffnet…",
    openFailed: "Produktentwürfe konnten nicht geöffnet werden. Geh zurück und versuche es erneut.",
    invalid: "Gib einen Produktnamen und einen Sprachcode aus zwei Buchstaben ein.",
    saveFailed: "Der Entwurf konnte nicht gespeichert werden. Versuche es erneut.",
  },
};

type LocalQueue = Awaited<ReturnType<typeof openLocalOffContributionQueue>>["queue"];
type Outcome = ReturnType<LocalQueue["enqueue"]>["status"];

function Field({
  label,
  value,
  limit,
  onChange,
}: {
  label: string;
  value: string;
  limit: number;
  onChange: (value: string) => void;
}) {
  return (
    <View style={local.field}>
      <Text style={styles.meta}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        maxLength={limit}
        onChangeText={onChange}
        style={local.input}
      />
    </View>
  );
}

export function OffContributionReview({
  barcode,
  locale,
  t,
  onBack,
}: {
  barcode: string;
  locale: string;
  t: Strings;
  onBack: () => void;
}) {
  const german = locale.startsWith("de");
  const labels = german ? copy.de : copy.en;
  const [queue, setQueue] = useState<LocalQueue | null>();
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [quantity, setQuantity] = useState("");
  const [language, setLanguage] = useState(german ? "de" : "en");
  const [reviewed, setReviewed] = useState<OffContributionProduct>();
  const [outcome, setOutcome] = useState<Outcome>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    let close: (() => Promise<void>) | undefined;
    void openLocalOffContributionQueue()
      .then((resource) => {
        if (disposed) return resource.close();
        close = resource.close;
        setQueue(resource.queue);
      })
      .catch(() => {
        if (!disposed) setQueue(null);
      });
    return () => {
      disposed = true;
      if (close) void close().catch(() => {});
    };
  }, []);

  function review() {
    if (!queue) return;
    try {
      setReviewed(
        queue.preview({
          barcode,
          language,
          name,
          brand: brand.trim() || null,
          packageQuantity: quantity.trim() || null,
        }),
      );
      Keyboard.dismiss();
      setError(undefined);
    } catch {
      setError(labels.invalid);
    }
  }

  function save() {
    if (!queue || !reviewed) return;
    try {
      setOutcome(queue.enqueue(reviewed, Date.now()).status);
      setError(undefined);
    } catch {
      setError(labels.saveFailed);
    }
  }

  function back() {
    if (reviewed && !outcome) {
      setReviewed(undefined);
      setError(undefined);
      return;
    }
    onBack();
  }

  const details = reviewed && [
    [labels.name, reviewed.name],
    [labels.language, reviewed.language],
    [labels.brand, reviewed.brand],
    [labels.quantity, reviewed.packageQuantity],
  ];

  return (
    <>
      <DetailHeader title={labels.title} subtitle={barcode} back={t.back} onBack={back} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {queue === undefined && <Notice pending text={labels.loading} />}
        {queue === null && <Notice text={labels.openFailed} />}
        {queue && !reviewed && (
          <>
            <Field label={labels.name} value={name} limit={256} onChange={setName} />
            <Field label={labels.language} value={language} limit={2} onChange={setLanguage} />
            <Field label={labels.brand} value={brand} limit={256} onChange={setBrand} />
            <Field label={labels.quantity} value={quantity} limit={64} onChange={setQuantity} />
            <PrimaryButton title={labels.review} onPress={review} />
          </>
        )}
        {details && !outcome && (
          <>
            <View style={styles.card}>
              {details.map(([label, value]) =>
                value ? (
                  <View key={label}>
                    <Text style={styles.meta}>{label}</Text>
                    <Text style={styles.body}>{value}</Text>
                  </View>
                ) : null,
              )}
            </View>
            <PrimaryButton title={labels.queue} onPress={save} />
          </>
        )}
        {outcome && (
          <Notice
            text={
              {
                queued: labels.saved,
                "already-queued": labels.repeated,
                "different-draft": labels.different,
              }[outcome]
            }
          />
        )}
        {error && <Notice text={error} />}
      </ScrollView>
    </>
  );
}

const local = StyleSheet.create({
  field: { gap: 6 },
  input: {
    color: colors.text,
    backgroundColor: colors.field,
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 12,
    fontSize: 16,
  },
});

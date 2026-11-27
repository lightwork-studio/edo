import {
  ArchiveIssueLimitError,
  type PrivateArchivePreview,
  type PrivateArchiveResult,
  type PrivateArchiveStore,
} from "@edo/storage";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  ArchiveComplexityError,
  ArchiveSizeError,
  chooseArchive,
  pruneArchiveExports,
  shareArchive,
} from "./archive-files";
import type { Strings } from "./strings";
import { DetailHeader, Notice, PrimaryButton, styles } from "./ui";

type Selection = { source: string; preview: PrivateArchivePreview };
const maxPreviewIssues = 100;
const maxDisplayedIssues = 12;

export function ArchiveScreen({
  t,
  archive,
  onRestored,
  onBack,
}: {
  t: Strings;
  archive: PrivateArchiveStore;
  onRestored: () => void;
  onBack: () => void;
}) {
  const ongoing = useRef(false);
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<
    "share" | "choose" | "restore" | "size" | "complexity" | "issues" | null
  >(null);
  const [result, setResult] = useState<Extract<
    PrivateArchiveResult,
    { status: "restored" }
  > | null>(null);
  useEffect(() => {
    active.current = true;
    pruneArchiveExports();
    return () => {
      active.current = false;
    };
  }, []);

  async function run(kind: "share" | "choose" | "restore", operation: () => Promise<void> | void) {
    if (ongoing.current) return;
    ongoing.current = true;
    setError(null);
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      if (active.current) {
        if (error instanceof ArchiveSizeError) setError("size");
        else if (error instanceof ArchiveComplexityError) setError("complexity");
        else if (error instanceof ArchiveIssueLimitError) {
          setSelection(null);
          setError("issues");
        } else setError(kind);
      }
    } finally {
      ongoing.current = false;
      if (active.current) setBusy(false);
    }
  }

  const errors = {
    share: t.archiveShareError,
    choose: t.archiveOpenError,
    restore: t.archiveRestoreError,
    size: t.archiveSizeError,
    complexity: t.archiveComplexityError,
    issues: t.archiveIssueLimitError,
  };
  return (
    <>
      <DetailHeader title={t.diaryFiles} back={t.back} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.body}>{t.archiveFileDetail}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            style={styles.action}
            onPress={() => void run("share", () => shareArchive(archive.exportPrivateArchive()))}
          >
            <Text style={styles.actionText}>{t.shareDiaryArchive}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            style={styles.action}
            onPress={() =>
              void run("choose", async () => {
                setSelection(null);
                setResult(null);
                const source = await chooseArchive();
                if (source !== null && active.current) {
                  setSelection({
                    source,
                    preview: archive.previewPrivateArchive(source, maxPreviewIssues),
                  });
                }
              })
            }
          >
            <Text style={styles.actionText}>{t.chooseDiaryArchive}</Text>
          </Pressable>
        </View>
        {busy && <Notice text={t.loading} pending />}
        {error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {errors[error]}
          </Text>
        )}
        {result && (
          <Text accessibilityLiveRegion="polite" style={styles.actionText}>
            {t.archiveRestored(result.added, result.alreadyPresent)}
          </Text>
        )}
        {selection && (
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.title}>
              {t.archivePreview}
            </Text>
            <Text style={styles.body}>
              {t.archiveCounts(selection.preview.newRecords, selection.preview.alreadyPresent)}
            </Text>
            {selection.preview.issues.length > 0 && (
              <Text accessibilityRole="alert" style={styles.error}>
                {t.archiveConflicts(selection.preview.issues.length)}
              </Text>
            )}
            {selection.preview.issues
              .slice(0, maxDisplayedIssues)
              .map(({ collection, index, message }) => (
                <Text key={`${collection}:${index}:${message}`} style={styles.meta}>
                  {t.archiveCollection[collection]} · {index + 1} · {message}
                </Text>
              ))}
            {selection.preview.issues.length > maxDisplayedIssues && (
              <Text style={styles.meta}>{t.archiveIssueSample(maxDisplayedIssues)}</Text>
            )}
          </View>
        )}
      </ScrollView>
      {selection &&
        !busy &&
        selection.preview.issues.length === 0 &&
        selection.preview.newRecords > 0 && (
          <View style={styles.footer}>
            <PrimaryButton
              title={t.restoreDiaryArchive}
              onPress={() =>
                void run("restore", () => {
                  const restored = archive.restorePrivateArchive(
                    selection.source,
                    maxPreviewIssues,
                  );
                  if (restored.status === "rejected")
                    setSelection({ ...selection, preview: restored.preview });
                  else {
                    setSelection(null);
                    setResult(restored);
                    onRestored();
                  }
                })
              }
            />
          </View>
        )}
    </>
  );
}

import { FddbCsvRecordLimitError } from "@edo/core";
import type { PrivateArchiveResult, PrivateArchiveStore } from "@edo/storage";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  chooseFddbCsv,
  DiaryFileProviderBusyError,
  DiaryFileReadTimeoutError,
  DiaryFileSizeError,
} from "./diary-file-picker";
import { InvalidFddbSourceTimeZone, previewFddbFile } from "./fddb-file-import";
import type { Strings } from "./strings";
import { colors, DetailHeader, Notice, PrimaryButton, styles } from "./ui";

type FddbFilePreview = Awaited<ReturnType<typeof previewFddbFile>>;
type ImportError =
  | "open"
  | "preview"
  | "apply"
  | "size"
  | "records"
  | "timeZone"
  | "timeout"
  | "provider";

const issueSampleLimit = 12;

function importError(error: unknown, fallback: ImportError): ImportError {
  if (error instanceof DiaryFileSizeError) return "size";
  if (error instanceof FddbCsvRecordLimitError) return "records";
  if (error instanceof InvalidFddbSourceTimeZone) return "timeZone";
  if (error instanceof DiaryFileReadTimeoutError) return "timeout";
  if (error instanceof DiaryFileProviderBusyError) return "provider";
  return fallback;
}

export function FddbImportScreen({
  t,
  diary,
  onImported,
  onBack,
}: {
  t: Strings;
  diary: PrivateArchiveStore;
  onImported: () => void;
  onBack: () => void;
}) {
  const active = useRef(false);
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [preview, setPreview] = useState<FddbFilePreview | null>(null);
  const [issue, setIssue] = useState<ImportError | null>(null);
  const [result, setResult] = useState<Extract<
    PrivateArchiveResult,
    { status: "restored" }
  > | null>(null);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function run(fallback: ImportError, action: () => Promise<void>) {
    if (working.current || !active.current) return;
    working.current = true;
    setIssue(null);
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (active.current) setIssue(importError(error, fallback));
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  }

  const canImport =
    preview?.archive && preview.storage.newRecords > 0 && !preview.storage.issues.length;
  return (
    <>
      <DetailHeader title={t.fddbImport} back={t.back} onBack={onBack} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            style={styles.action}
            onPress={() =>
              void run("open", async () => {
                const csv = await chooseFddbCsv();
                if (csv === null || !active.current) return;
                setSource(csv);
                setPreview(null);
                setResult(null);
              })
            }
          >
            <Text style={styles.actionText}>{t.fddbChooseFile}</Text>
          </Pressable>
          {source !== null && (
            <>
              <Text style={styles.meta}>{t.fddbSourceTimeZone}</Text>
              <TextInput
                accessibilityLabel={t.fddbSourceTimeZone}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                maxLength={100}
                placeholder="Europe/Berlin"
                placeholderTextColor={colors.muted}
                value={timeZone}
                onChangeText={(value) => {
                  setTimeZone(value);
                  setPreview(null);
                  setIssue(null);
                }}
                style={local.input}
              />
              <Text style={styles.meta}>{t.fddbTimeZoneHint}</Text>
              {!busy && (
                <PrimaryButton
                  title={t.fddbPreview}
                  onPress={() =>
                    void run("preview", async () => {
                      setPreview(null);
                      const draft = await previewFddbFile(source, timeZone, diary, (text) => {
                        if (!active.current) throw new Error("Import view closed");
                        return digestStringAsync(CryptoDigestAlgorithm.SHA256, text);
                      });
                      if (active.current) setPreview(draft);
                    })
                  }
                />
              )}
            </>
          )}
        </View>
        {busy && <Notice text={t.loading} pending />}
        {issue && (
          <Text style={styles.error} accessibilityRole="alert">
            {t.fddbErrors[issue]}
          </Text>
        )}
        {result && (
          <Text style={styles.actionText} accessibilityLiveRegion="polite">
            {t.fddbSaved(result.added, result.alreadyPresent)}
          </Text>
        )}
        {preview && (
          <View style={styles.card}>
            {preview.incompleteAtLine !== null && (
              <Text style={styles.error} accessibilityRole="alert">
                {t.fddbIncomplete(preview.incompleteAtLine)}
              </Text>
            )}
            <Text style={styles.body} accessibilityLiveRegion="polite">
              {t.fddbPreviewCounts(preview.storage.newRecords, preview.storage.alreadyPresent)}
            </Text>
            {(preview.activityRows > 0 || preview.issues.length > 0) && (
              <Text style={styles.meta}>
                {t.fddbSkipped(preview.activityRows, preview.issues.length)}
              </Text>
            )}
            {preview.issues.slice(0, issueSampleLimit).map(({ line, code }) => (
              <Text key={`${line}:${code}`} style={styles.meta}>
                {t.fddbRowIssue(line, t.fddbIssues[code])}
              </Text>
            ))}
            {preview.issues.length > issueSampleLimit && (
              <Text style={styles.meta}>{t.fddbIssueSample(issueSampleLimit)}</Text>
            )}
            {preview.storage.issues.length > 0 && (
              <Text style={styles.error} accessibilityRole="alert">
                {t.fddbStoredConflicts(preview.storage.issues.length)}
              </Text>
            )}
          </View>
        )}
      </ScrollView>
      {canImport && !busy && (
        <View style={styles.footer}>
          <PrimaryButton
            title={t.fddbApply(preview.storage.newRecords)}
            onPress={() =>
              void run("apply", async () => {
                await new Promise<void>((resolve) => {
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                });
                if (!active.current || preview.archive === null) return;
                const saved = diary.restorePrivateArchive(preview.archive);
                if (saved.status === "rejected") {
                  setPreview({ ...preview, storage: saved.preview });
                  return;
                }
                setResult(saved);
                setPreview(null);
                setSource(null);
                onImported();
              })
            }
          />
        </View>
      )}
    </>
  );
}

const local = StyleSheet.create({
  input: {
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.field,
    color: colors.text,
    fontSize: 16,
  },
});

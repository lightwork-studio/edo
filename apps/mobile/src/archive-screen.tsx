import type { PrivateArchiveStore } from "@edo/storage";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  ArchiveComplexityError,
  ArchiveSizeError,
  pruneArchiveExports,
  shareArchive,
} from "./archive-files";
import type { Strings } from "./strings";
import { DetailHeader, Notice, styles } from "./ui";

export function ArchiveScreen({
  t,
  archive,
  onBack,
}: {
  t: Strings;
  archive: Pick<PrivateArchiveStore, "exportPrivateArchive">;
  onBack: () => void;
}) {
  const sharing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    pruneArchiveExports();
  }, []);

  async function share() {
    if (sharing.current) return;
    sharing.current = true;
    setBusy(true);
    setError(null);
    try {
      await shareArchive(archive.exportPrivateArchive());
    } catch (error) {
      if (error instanceof ArchiveSizeError) setError(t.archiveSizeError);
      else if (error instanceof ArchiveComplexityError) setError(t.archiveComplexityError);
      else setError(t.archiveShareError);
    } finally {
      sharing.current = false;
      setBusy(false);
    }
  }

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
            onPress={() => void share()}
          >
            <Text style={styles.actionText}>{t.shareDiaryArchive}</Text>
          </Pressable>
        </View>
        {busy && <Notice text={t.loading} pending />}
        {error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
      </ScrollView>
    </>
  );
}

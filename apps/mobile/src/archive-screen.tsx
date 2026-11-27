import type { PrivateArchiveStore } from "@edo/storage";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { shareArchive } from "./archive-files";
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
  const [failed, setFailed] = useState(false);

  async function share() {
    if (sharing.current) return;
    sharing.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await shareArchive(archive.exportPrivateArchive());
    } catch {
      setFailed(true);
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
        {failed && (
          <Text accessibilityRole="alert" style={styles.error}>
            {t.archiveShareError}
          </Text>
        )}
      </ScrollView>
    </>
  );
}

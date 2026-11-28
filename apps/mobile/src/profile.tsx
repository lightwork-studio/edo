import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Strings } from "./strings";
import { colors, styles } from "./ui";

export function ProfileScreen({
  t,
  onTargets,
  onDiaryFiles,
}: {
  t: Strings;
  onTargets: () => void;
  onDiaryFiles: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.heading}>
        {t.profile}
      </Text>
      <View style={[styles.card, local.card]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.nutritionTargets}
          onPress={onTargets}
          style={({ pressed }) => [styles.row, local.row, pressed && styles.pressed]}
        >
          <Text style={[styles.body, styles.stretch]}>{t.nutritionTargets}</Text>
          <Text importantForAccessibility="no" style={local.chevron}>
            ›
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.diaryFiles}
          onPress={onDiaryFiles}
          style={({ pressed }) => [styles.row, local.row, local.divider, pressed && styles.pressed]}
        >
          <Text style={[styles.body, styles.stretch]}>{t.diaryFiles}</Text>
          <Text importantForAccessibility="no" style={local.chevron}>
            ›
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const local = StyleSheet.create({
  card: { paddingVertical: 0, gap: 0 },
  row: { minHeight: 52, paddingVertical: 8 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  chevron: { color: colors.muted, fontSize: 22 },
});

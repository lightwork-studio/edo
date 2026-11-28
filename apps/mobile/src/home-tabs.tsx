import { Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import type { Strings } from "./strings";
import { colors, styles } from "./ui";

export type HomeTab = "diary" | "my-foods" | "progress" | "profile";

const icons = {
  diary: require("../assets/navigation/today.png"),
  "my-foods": require("../assets/navigation/foods.png"),
  progress: require("../assets/navigation/progress.png"),
  profile: require("../assets/navigation/profile.png"),
};

export function HomeTabs({
  t,
  active,
  onTab,
  onLog,
}: {
  t: Strings;
  active: HomeTab;
  onTab: (tab: HomeTab) => void;
  onLog?: () => void;
}) {
  const { width } = useWindowDimensions();
  const logSize = Math.min(64, Math.max(44, Math.floor(width / 5) - 2));
  const labels = {
    diary: t.today,
    "my-foods": t.foods,
    progress: t.progress,
    profile: t.profile,
  };

  function tab(kind: HomeTab) {
    const selected = kind === active;
    return (
      <Pressable
        accessibilityRole="tab"
        accessibilityLabel={labels[kind]}
        accessibilityState={{ selected }}
        onPress={() => onTab(kind)}
        style={({ pressed }) => [local.tab, pressed && styles.pressed]}
      >
        <Image
          source={icons[kind]}
          importantForAccessibility="no"
          style={[local.icon, { tintColor: selected ? colors.accent : colors.muted }]}
        />
        <Text
          numberOfLines={2}
          adjustsFontSizeToFit
          style={[local.label, selected && local.selected]}
        >
          {labels[kind]}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={local.container}>
      <View pointerEvents="none" style={local.bar} />
      {tab("diary")}
      {tab("my-foods")}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.addFood}
        accessibilityState={{ disabled: !onLog }}
        disabled={!onLog}
        onPress={onLog}
        style={({ pressed }) => [local.log, !onLog && styles.faded, pressed && styles.pressed]}
      >
        <View
          style={[local.logCircle, { width: logSize, height: logSize, borderRadius: logSize / 2 }]}
        >
          <Text importantForAccessibility="no" style={local.plus}>
            +
          </Text>
        </View>
        <Text numberOfLines={1} adjustsFontSizeToFit style={[local.label, local.logLabel]}>
          {t.logMealAction}
        </Text>
      </Pressable>
      {tab("progress")}
      {tab("profile")}
    </View>
  );
}

const local = StyleSheet.create({
  container: { flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 4 },
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    top: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: "#1A1B1D",
  },
  tab: { flex: 1, minHeight: 56, alignItems: "center", justifyContent: "center", gap: 3 },
  icon: { width: 24, height: 24 },
  label: { color: colors.muted, fontSize: 11, fontWeight: "600", textAlign: "center" },
  selected: { color: colors.accent, fontWeight: "700" },
  log: { flex: 1, alignItems: "center", gap: 3, paddingBottom: 3 },
  logCircle: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
    borderWidth: 4,
    borderColor: "#1A1B1D",
  },
  plus: { color: colors.accentText, fontSize: 31, fontWeight: "600", lineHeight: 35 },
  logLabel: { color: colors.text },
});

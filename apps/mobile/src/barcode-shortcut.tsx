import { Pressable, StyleSheet, View } from "react-native";
import { colors, styles } from "./ui";

export function BarcodeShortcut({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
      onPress={onPress}
    >
      <View
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={local.mark}
      >
        <View style={local.bar} />
        <View style={local.wide} />
        <View style={local.bar} />
        <View style={local.wide} />
        <View style={local.bar} />
      </View>
    </Pressable>
  );
}

const local = StyleSheet.create({
  mark: {
    width: 22,
    height: 17,
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "space-between",
    paddingHorizontal: 2,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.text,
  },
  bar: { width: 1, backgroundColor: colors.text },
  wide: { width: 2, backgroundColor: colors.text },
});

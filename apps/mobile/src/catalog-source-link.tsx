import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text } from "react-native";
import { styles } from "./ui";

export function SourceLink({ uri, title }: { uri: string; title: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <Text selectable style={styles.meta}>
      {uri}
    </Text>
  ) : (
    <Pressable
      accessibilityRole="link"
      style={local.link}
      onPress={() => void Linking.openURL(uri).catch(() => setFailed(true))}
    >
      <Text style={styles.actionText}>{title}</Text>
    </Pressable>
  );
}

const local = StyleSheet.create({ link: { minHeight: 44, justifyContent: "center" } });

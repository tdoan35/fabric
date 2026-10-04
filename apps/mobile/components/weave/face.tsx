import { Image, StyleSheet, Text, View } from "react-native";

import { avatar } from "@/lib/avatar";
import { theme } from "@/lib/theme";

/**
 * Persona portrait at a fixed size, or an initial circle when a slug has no art ("you" renders
 * Ty's initial, like the web's Face). Web counterpart: components/weave/parts.tsx Face.
 */

export function Face({ agentId, size }: { agentId: string; size: number }) {
  const source = avatar(agentId);
  if (source) {
    return (
      <Image
        source={source}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.secondary }}
      />
    );
  }
  return (
    <View style={[styles.fallback, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={{ fontSize: Math.round(size * 0.38), fontWeight: "600", color: theme.colors.foreground }}>
        {agentId === "you" ? "T" : agentId.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.secondary,
  },
});

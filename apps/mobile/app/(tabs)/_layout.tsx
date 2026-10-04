import { Pressable, StyleSheet, Text, View, type ColorValue } from "react-native";
import { Tabs, useRouter } from "expo-router";

import { theme } from "@/lib/theme";

function TabIcon({ glyph, color }: { glyph: string; color: ColorValue }) {
  return <Text style={[styles.icon, { color }]}>{glyph}</Text>;
}

export default function TabLayout() {
  const router = useRouter();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.colors.run,
        tabBarInactiveTintColor: theme.colors.mutedForeground,
        tabBarStyle: { backgroundColor: theme.colors.card, borderTopColor: theme.colors.border },
        headerStyle: { backgroundColor: theme.colors.card },
        headerTintColor: theme.colors.foreground,
        // M1 entries from either tab: Chat with Dana (app/chat.tsx), and the hidden debug screen
        // (app/debug.tsx — the network check).
        headerRight: () => (
          <View style={styles.headerActions}>
            <Pressable hitSlop={12} onPress={() => router.push("/chat")} style={styles.chat}>
              <Text style={styles.chatText}>✉</Text>
            </Pressable>
            <Pressable hitSlop={12} onPress={() => router.push("/debug")} style={styles.debug}>
              <Text style={styles.debugText}>⌘</Text>
            </Pressable>
          </View>
        ),
      }}>
      <Tabs.Screen
        name="weave"
        options={{ title: "Weave", tabBarIcon: ({ color }) => <TabIcon glyph="✦" color={color} /> }}
      />
      <Tabs.Screen
        name="work"
        options={{ title: "Work", tabBarIcon: ({ color }) => <TabIcon glyph="▦" color={color} /> }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: "row", alignItems: "center" },
  icon: { fontSize: 18, textAlign: "center" },
  chat: { marginRight: 16 },
  chatText: { color: theme.colors.foreground, fontSize: 15 },
  debug: { marginRight: 14 },
  debugText: { color: theme.colors.mutedForeground, fontSize: 14 },
});

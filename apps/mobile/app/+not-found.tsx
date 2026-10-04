import { Link, Stack } from "expo-router";
import { StyleSheet, Text } from "react-native";

import { Screen } from "@/components/ui";
import { theme } from "@/lib/theme";

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Not found" }} />
      <Screen>
        <Text style={styles.title}>This screen doesn&apos;t exist.</Text>
        <Link href="/" style={styles.link}>
          <Text style={styles.linkText}>Go to Weave</Text>
        </Link>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  title: { color: theme.colors.foreground, fontSize: 18, fontWeight: "600", textAlign: "center", marginTop: 48 },
  link: { marginTop: 16, paddingVertical: 12, alignSelf: "center" },
  linkText: { color: theme.colors.run, fontSize: 14 },
});

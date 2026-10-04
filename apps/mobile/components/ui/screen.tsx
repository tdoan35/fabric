import type { PropsWithChildren } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native";
import { theme } from "@/lib/theme";

/** Full-height dark surface below any native header / tab bar. */
export function Screen({ children }: PropsWithChildren) {
  return <SafeAreaView style={styles.screen} edges={["left", "right", "bottom"]}>{children}</SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background, paddingHorizontal: 16 },
});

import type { PropsWithChildren } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native";
import { AuroraBackground } from "./aurora";

/** Full-height surface below any native header / tab bar, over the web's aurora backdrop. */
export function Screen({ children }: PropsWithChildren) {
  return (
    <SafeAreaView style={styles.screen} edges={["left", "right", "bottom"]}>
      <AuroraBackground />
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#020617", paddingHorizontal: 16 },
});

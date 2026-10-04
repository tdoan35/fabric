import { DarkTheme, Stack, ThemeProvider, type Theme } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { theme } from "@/lib/theme";

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from "expo-router";

export const unstable_settings = {
  // Ensure that reloading on a pushed screen keeps a back button present.
  initialRouteName: "(tabs)",
};

/** Dark-first (MOBILE-PLAN §3): the web's .dark tokens driving React Navigation's chrome. */
const navTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: theme.colors.run,
    background: theme.colors.background,
    card: theme.colors.card,
    text: theme.colors.foreground,
    border: theme.colors.border,
    notification: theme.colors.warn,
  },
};

export default function RootLayout() {
  return (
    <ThemeProvider value={navTheme}>
      <StatusBar style="light" />
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="weave/[id]" options={{ title: "Weave" }} />
        <Stack.Screen name="report/[id]" options={{ title: "Report" }} />
        <Stack.Screen name="chat" options={{ title: "Dana" }} />
        <Stack.Screen name="debug" options={{ title: "Debug" }} />
      </Stack>
    </ThemeProvider>
  );
}

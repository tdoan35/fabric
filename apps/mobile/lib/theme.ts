// Design tokens copied from apps/web/src/styles/globals.css — dark first, which is the demo look.
// RN's StyleSheet doesn't parse oklch(), so the oklch tokens are converted to sRGB hex
// (achromatic oklch L → linear sRGB → gamma; computed, not eyeballed).
// The status families (run/ok/warn/replay) were already hex on the web and are copied verbatim.

export const dark = {
  background: "#0a0a0a", // oklch(0.145 0 0)
  foreground: "#fafafa", // oklch(0.985 0 0)
  card: "#171717", // oklch(0.205 0 0)
  cardForeground: "#fafafa",
  primary: "#e5e5e5", // oklch(0.922 0 0)
  primaryForeground: "#171717",
  secondary: "#262626", // oklch(0.269 0 0)
  secondaryForeground: "#fafafa",
  muted: "#262626",
  mutedForeground: "#a1a1a1", // oklch(0.708 0 0)
  accent: "#262626",
  accentForeground: "#fafafa",
  destructive: "#ff6467", // oklch(0.704 0.191 22.216)
  border: "rgba(255,255,255,0.10)", // oklch(1 0 0 / 10%)
  input: "rgba(255,255,255,0.15)", // oklch(1 0 0 / 15%)
  ring: "#737373", // oklch(0.556 0 0)
  sidebarPrimary: "#1447e6", // oklch(0.488 0.243 264.376)

  run: "#93b4ff",
  runSoft: "#1e2d5a",
  ok: "#6ee7a0",
  okSoft: "#12351f",
  warn: "#fbbf6a",
  warnSoft: "#3a2a0c",
  replay: "#c4b5fd",
  replaySoft: "#2e2150",
} as const;

/** The web's :root (light) palette, for a later appearance toggle. Unused until then. */
export const light = {
  background: "#ffffff",
  foreground: "#0a0a0a",
  card: "#ffffff",
  cardForeground: "#0a0a0a",
  primary: "#171717",
  primaryForeground: "#fafafa",
  secondary: "#f5f5f5", // oklch(0.97 0 0)
  secondaryForeground: "#0a0a0a",
  muted: "#f5f5f5",
  mutedForeground: "#737373", // oklch(0.556 0 0)
  accent: "#f5f5f5",
  accentForeground: "#0a0a0a",
  destructive: "#e7000b", // oklch(0.577 0.245 27.325)
  border: "#e5e5e5", // oklch(0.922 0 0)
  input: "#e5e5e5",
  ring: "#a1a1a1", // oklch(0.708 0 0)
  sidebarPrimary: "#171717",

  run: "#1d4ed8",
  runSoft: "#dbeafe",
  ok: "#15803d",
  okSoft: "#dcfce7",
  warn: "#b45309",
  warnSoft: "#fef3c7",
  replay: "#6d28d9",
  replaySoft: "#ede9fe",
} as const;

/** --radius 0.625rem = 10px; sm…xxl are the calc() multiples from globals.css. */
export const radius = { sm: 6, md: 8, lg: 10, xl: 14, xxl: 18, full: 999 } as const;

/** The app renders dark-first (MOBILE-PLAN §3); `light` is kept for a future toggle. */
export const theme = { colors: dark, radius } as const;

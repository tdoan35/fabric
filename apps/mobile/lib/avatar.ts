// Persona portraits: the web's assets are 384×384 WebP stills (apps/web/public/agents/*.webp,
// plus dana's idle still), copied into assets/portraits/. WebP is in Metro's default assetExts
// and renders on iOS 14+/Android, so RN can require() them. Dana's animated sprite strip
// (happy-idle-strip.webp, 14016×192) stays web-only. Static requires — RN has no dynamic paths.
const portraits = {
  bea: require("../assets/portraits/bea-happy.webp"),
  carlos: require("../assets/portraits/carlos-happy.webp"),
  dana: require("../assets/portraits/dana-happy.webp"),
  diego: require("../assets/portraits/diego-happy.webp"),
  elliot: require("../assets/portraits/elliot-happy.webp"),
  jonah: require("../assets/portraits/jonah-happy.webp"),
  lila: require("../assets/portraits/lila-happy.webp"),
  maya: require("../assets/portraits/maya-happy.webp"),
  megan: require("../assets/portraits/megan-happy.webp"),
  nadine: require("../assets/portraits/nadine-happy.webp"),
  nikhil: require("../assets/portraits/nikhil-happy.webp"),
  rosa: require("../assets/portraits/rosa-happy.webp"),
  sana: require("../assets/portraits/sana-happy.webp"),
  yuki: require("../assets/portraits/yuki-happy.webp"),
} as const;

type PortraitId = keyof typeof portraits;

/** The still portrait for a persona slug (agent ids are persona slugs), or undefined. */
export function avatar(agentId: string | undefined): number | undefined {
  if (!agentId) return undefined;
  return agentId in portraits ? portraits[agentId as PortraitId] : undefined;
}

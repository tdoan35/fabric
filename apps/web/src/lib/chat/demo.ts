// The demo build (VITE_DEMO=1, D7): hides group chat, Full auto, voice and the 1M context meter, and
// locks "Runs on" to the Sprite sandbox — in the chat, the composer and Settings.
export const demoMode = import.meta.env.VITE_DEMO === "1";

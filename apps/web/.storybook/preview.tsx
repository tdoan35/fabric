import type { Preview } from "@storybook/react-vite";
import "../src/styles/globals.css";
import "../src/lib/fonts";

const preview: Preview = {
  parameters: {
    layout: "centered",
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },
  globalTypes: {
    theme: {
      description: "Light/dark via the app's `.dark` class on <html>",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "light", icon: "sun", title: "Light" },
          { value: "dark", icon: "moon", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  decorators: [
    (Story, context) => {
      document.documentElement.classList.toggle("dark", context.globals.theme === "dark");
      return <Story />;
    },
  ],
};

export default preview;

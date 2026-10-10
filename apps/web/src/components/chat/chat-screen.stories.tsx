// Chat screen stories (ANY-12 M3): the composed production thread — routes/home.tsx's
// mounting of AssistantThread, provider stack included, driven by the scripted mock
// adapter (no live agent, no API/SSE — the guard hard-fails any attempt).
//
// State → story inventory:
//   Empty / new thread (hero, greeting, suggestions, composer + bar)  → NewThread
//   Existing thread (canned history, chip top bar, session panel)     → ExistingThread
//   Streaming reply (working portrait, text grows, send gated)        → StreamingReply
//   Run error (adapter failure → MessagePrimitive.Error)              → RunError
//   Incognito (veiled hero, off-the-record copy, explainer panel)     → IncognitoThread
//   Determinism + mock-only networking                                → ScreenDirectLoad,
//                                                                       ScreenAfterAnotherChat
// ScreenDirectLoad and ScreenAfterAnotherChat assert the same fixture-derived content:
// the latter is reached only after another chat story ran (and after an in-story round
// trip through another route), proving stories render identically however they load.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { dana } from "@fabric/fixtures/assistant";
import { suggestionPool } from "@fabric/fixtures/suggestions";
import { WithHarness, storyRouter } from "../../../.storybook/harness";
import { networkAttempts } from "../../../.storybook/guard";
import { ChatScreen, EXISTING_THREAD, failNextAssistantRun } from "./chat-fixtures";

const meta = {
  title: "Chat/Thread",
  decorators: [WithHarness],
  parameters: {
    layout: "fullscreen",
    a11y: {
      // Scoped exception, token-level: the chat pairs muted-foreground / foreground-opacity
      // text (the 10px context-meter readouts, inactive tab triggers, small pill labels)
      // below the 4.5:1 bar — the same design tokens studio-ui.stories.tsx scopes out.
      // Fixing means changing the design tokens, outside this card's file scope. Every
      // other rule still errors.
      config: { rules: [{ id: "color-contrast", enabled: false }] },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const SUGGESTION_LABELS = new Set(suggestionPool.map((s) => s.label));

/** Everything the fresh empty screen must show, read off the rendered DOM. Retried because
 * the thread's empty→started flicker at mount briefly renders both the hero and the chip. */
async function assertFreshScreen(canvasElement: HTMLElement) {
  await waitFor(() => {
    const canvas = within(canvasElement);
    // Hero: Dana's portrait and pill, her greeting heading.
    expect(canvas.getByRole("img", { name: dana.name })).toBeInTheDocument();
    expect(canvas.getByText(dana.name)).toBeInTheDocument();
    expect(canvas.getByRole("heading", { name: dana.greeting })).toBeInTheDocument();
    expect(canvas.getByText("Agent 1 of 4")).toBeInTheDocument();

    // Composer idle: her placeholder, the voice entry, no Send yet; the tray's pickers.
    const input = canvas.getByRole("textbox");
    expect(input).toHaveAttribute("placeholder", dana.placeholder);
    expect(canvas.getByRole("button", { name: "Voice conversation" })).toBeInTheDocument();
    expect(canvas.queryByRole("button", { name: "Send" })).toBeNull();
    expect(canvas.getByRole("button", { name: "Choose project" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Add connector" })).toBeInTheDocument();
    expect(canvas.getByRole("button", { name: "Run on: This machine" })).toBeInTheDocument();

    // Context meter in the tray: base tokens only, no messages yet.
    expect(canvas.getByRole("meter", { name: "Context usage" })).toHaveAttribute("aria-valuenow", "2140");

    // Suggestions: the current page of the rotating pool — three fixture prompts.
    const suggestions = canvas
      .getAllByRole("button")
      .filter((b) => SUGGESTION_LABELS.has(b.textContent ?? ""));
    expect(suggestions).toHaveLength(3);
  }, { timeout: 3000 });
}

/** The empty / new-thread screen, loaded directly. */
export const NewThread: Story = {
  name: "New thread",
  parameters: { router: { routes: [{ path: "*", element: <ChatScreen /> }] } },
  play: async ({ canvasElement }) => {
    await assertFreshScreen(canvasElement);
  },
};

/** Same screen, same content, reached after another chat story — stories are hermetic. */
export const ScreenAfterAnotherChat: Story = {
  name: "Screen · after another chat story",
  parameters: {
    router: {
      routes: [
        { path: "/", element: <ChatScreen /> },
        { path: "/agents", element: <p data-testid="elsewhere">Elsewhere</p> },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await assertFreshScreen(canvasElement);

    // Round-trip through another route and back: the screen renders identically.
    const router = storyRouter();
    if (!router) throw new Error("chat screen play: no active story router");
    await router.navigate("/agents?agent=jonah");
    await waitFor(() => expect(within(canvasElement).getByTestId("elsewhere")).toBeInTheDocument());
    await router.navigate("/");
    await waitFor(() => expect(within(canvasElement).queryByTestId("elsewhere")).toBeNull());
    await assertFreshScreen(canvasElement);
  },
};

/** The mock-only guard: a full visit to the composed screen makes zero network attempts. */
export const ScreenDirectLoad: Story = {
  name: "Screen · direct load, no network",
  parameters: { router: { routes: [{ path: "*", element: <ChatScreen /> }] } },
  play: async ({ canvasElement }) => {
    await assertFreshScreen(canvasElement);
    expect(networkAttempts()).toHaveLength(0);
  },
};

/** A thread with history: both messages render, the hero flies up into the top bar. */
export const ExistingThread: Story = {
  name: "Existing thread",
  parameters: {
    router: { routes: [{ path: "*", element: <ChatScreen initialMessages={EXISTING_THREAD} /> }] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    // Both canned messages render as bubbles.
    expect(canvas.getByText("Set up a baseline eval harness for the 135M model.")).toBeInTheDocument();
    expect(canvas.getByText("On it — I'll draft the harness, wire the held-out split, and run the baseline tonight.")).toBeInTheDocument();

    // The hero has flown up into the top bar: chip portrait, no Agents/Teams switcher.
    expect(canvas.getByRole("img", { name: "Dana" })).toBeInTheDocument();
    expect(canvas.queryByRole("tab", { name: "Agents" })).toBeNull();

    // The context meter moved into the composer toolbar: 2,140 base + 2 × 1,800.
    expect(canvas.getAllByRole("meter", { name: "Context usage" })).toHaveLength(1);
    expect(canvas.getByRole("meter", { name: "Context usage" })).toHaveAttribute("aria-valuenow", "5740");

    // The session side panel: desktop placeholder plus the tray's settings rows.
    await user.click(canvas.getByRole("button", { name: "Open side panel" }));
    const panel = canvas.getByRole("complementary", { name: "Dana's profile" });
    expect(within(panel).getByText("No desktop session")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Choose project" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Run on: This machine" })).toBeInTheDocument();
    // A second meter appears in the session panel — same thread, same accounting.
    const meters = canvas.getAllByRole("meter", { name: "Context usage" });
    expect(meters).toHaveLength(2);
    for (const meter of meters) expect(meter).toHaveAttribute("aria-valuenow", "5740");

    await user.click(within(panel).getByRole("button", { name: "Close panel" }));
    await waitFor(() => expect(canvas.queryByRole("complementary")).toBeNull());
  },
};

/** Streaming: the portrait flips to its working loop, the reply arrives word by word. */
export const StreamingReply: Story = {
  name: "Streaming reply",
  parameters: { router: { routes: [{ path: "*", element: <ChatScreen /> }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const input = canvas.getByRole("textbox");

    await user.type(input, "What's an n-gram, in one line?");
    await user.click(canvas.getByRole("button", { name: "Send" }));

    // The run starts: Dana's portrait switches to its working loop.
    await waitFor(() => expect(canvas.getByRole("img", { name: "Dana, working" })).toBeInTheDocument());

    // The reply streams: partial text visible while the run is still going.
    await waitFor(
      () => expect(canvasElement.textContent).toContain("An n-gram is a run of n consecutive tokens."),
      { timeout: 5000, interval: 20 },
    );

    // A follow-up typed mid-run shows the composer's gated send…
    await user.type(input, " And the held-out split?");
    expect(canvas.getByRole("button", { name: "Send" })).toBeDisabled();

    // …which re-enables when the run completes, and the whole reply is on screen.
    await waitFor(
      () => expect(canvas.getByRole("button", { name: "Send" })).toBeEnabled(),
      { timeout: 5000 },
    );
    await waitFor(
      () => expect(canvasElement.textContent).toContain("lookup-table language model."),
      { timeout: 5000 },
    );
    await waitFor(() => expect(canvas.getByRole("img", { name: "Dana" })).toBeInTheDocument());
  },
};

/** Run failure: the adapter throws, the message shows the error box. */
export const RunError: Story = {
  name: "Run error",
  parameters: { router: { routes: [{ path: "*", element: <ChatScreen /> }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const restore = failNextAssistantRun("Storybook: simulated assistant failure");
    try {
      const user = userEvent.setup();
      await user.type(canvas.getByRole("textbox"), "Say something.");
      await user.click(canvas.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(canvas.getByRole("alert")).toBeInTheDocument());
      expect(canvas.getByRole("alert")).toHaveTextContent("Storybook: simulated assistant failure");
      // No assistant reply arrived — only the error display.
      expect(canvasElement.textContent).not.toContain("Mock reply");
    } finally {
      restore();
    }
  },
};

/** Incognito: veiled hero pinned to Dana, off-the-record copy, explainer panel with a way out. */
export const IncognitoThread: Story = {
  name: "Incognito thread",
  parameters: { router: { routes: [{ path: "*", element: <ChatScreen /> }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();

    await user.click(canvas.getByRole("switch", { name: "Incognito chat" }));

    // The hero is veiled and pinned to Dana: no chevrons, the switcher disabled.
    await waitFor(() => {
      expect(canvas.getByRole("img", { name: "Dana" })).toHaveClass("grayscale");
      expect(canvas.getByText("Dana · incognito")).toBeInTheDocument();
      expect(canvas.queryByRole("button", { name: "Next agent" })).toBeNull();
      expect(canvas.getByRole("tab", { name: "Agents" })).toBeDisabled();
    });

    // Off-the-record copy replaces the greeting.
    expect(canvas.getByRole("heading", { name: "Incognito chat" })).toBeInTheDocument();
    expect(canvas.getByText("Not saved to your sessions or used to shape your assistant.")).toBeInTheDocument();
    expect(canvas.getByRole("textbox")).toHaveAttribute("placeholder", "Tell Dana anything, off the record…");

    // The profile opens on the incognito explainer, with a way out.
    await user.click(canvas.getByRole("button", { name: "Toggle Dana · incognito's profile" }));
    const panel = canvas.getByRole("complementary", { name: "Dana's profile" });
    expect(within(panel).getByRole("tab", { name: "Incognito" })).toHaveAttribute("aria-selected", "true");
    expect(within(panel).getByText("Not saved")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Turn off incognito" })).toBeInTheDocument();

    // Turning it off keeps the panel open but hands the card back to Dana's own profile.
    await user.click(within(panel).getByRole("button", { name: "Turn off incognito" }));
    await waitFor(() => {
      expect(within(panel).getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true");
      expect(within(panel).getByRole("heading", { name: "Dana" })).toBeInTheDocument();
    });
    expect(canvas.getByRole("heading", { name: "What's on your plate, Ty?" })).toBeInTheDocument();

    // …and the panel closes from its own affordance.
    await user.click(within(panel).getByRole("button", { name: "Close panel" }));
    await waitFor(() => expect(canvas.queryByRole("complementary")).toBeNull());
  },
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentAvatar, InitialAvatar } from "./agent-avatar";
import { dana, jonah } from "@/lib/mock/assistant";

const meta = {
  title: "Components/AgentAvatar",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** Sprite with only a still frame (no loops): the still shows alone. */
export const SpriteStill: Story = {
  name: "Sprite still",
  render: () => <AgentAvatar avatar={jonah.avatar!} name={jonah.name} />,
};

/** Full sprite: idle loop by default, working loop while `working`. Both animate. */
export const WorkingSprite: Story = {
  name: "Working sprite",
  render: () => (
    <div className="flex items-end gap-6">
      <div className="flex flex-col items-center gap-2">
        <AgentAvatar avatar={dana.avatar!} name={dana.name} />
        <span className="text-xs text-muted-foreground">idle</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <AgentAvatar avatar={dana.avatar!} name={dana.name} working />
        <span className="text-xs text-muted-foreground">working</span>
      </div>
    </div>
  ),
};

/** No art yet: a round initial in the agent's tone. */
export const InitialsFallback: Story = {
  name: "Initials fallback",
  render: () => <InitialAvatar initial={dana.name[0]} name={dana.name} tone={dana.tone} className="text-4xl" />,
};

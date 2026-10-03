import type { CSSProperties } from "react";
import type { SpriteAvatar } from "@/lib/mock/assistant";
import { cn } from "@/lib/utils";

/**
 * Round profile container that plays a sprite-strip idle loop.
 * - The still sits underneath, so there is never an empty frame while the strip loads.
 * - Plays forward then backward (alternate) so the loop has no visible seam.
 * - Reduced motion: the strip is hidden and only the still shows.
 */
export function AgentAvatar({ avatar, name, className }: { avatar: SpriteAvatar; name: string; className?: string }) {
  const { strip, frames, fps } = avatar;
  const animated = strip && frames && fps;
  const style = animated
    ? ({
        width: `${frames * 100}%`,
        "--sprite-end": `${-((frames - 1) / frames) * 100}%`,
        animation: `sprite-strip ${frames / fps}s steps(${frames}, jump-none) infinite alternate`,
      } as CSSProperties)
    : undefined;
  return (
    <div className={cn("relative size-28 shrink-0 overflow-hidden rounded-full bg-ok-soft shadow-sm", className)} role="img" aria-label={name}>
      <img src={avatar.still} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
      {animated && (
        <img src={strip} alt="" decoding="async" draggable={false} style={style} className="absolute left-0 top-0 h-full max-w-none will-change-transform motion-reduce:hidden" />
      )}
    </div>
  );
}

/** Fallback when an agent has no art yet: a round initial that matches the portrait container. */
export function InitialAvatar({ initial, name, tone, className }: { initial: string; name: string; tone: string; className?: string }) {
  return (
    <div
      className={cn("relative flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold shadow-sm", tone, className)}
      role="img"
      aria-label={name}
    >
      <span className="text-[2.6em] leading-none">{initial}</span>
    </div>
  );
}

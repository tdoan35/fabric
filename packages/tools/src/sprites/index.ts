// @fabric/tools/sprites (ANY-44 T9): the Sprites backend of the SandboxProvider —
// one sprite per (workspace, agent), folders by tar, open web, no broker route.
// Served through T1's subpath map; src/index.ts stays untouched, like ../sandbox.
export {
  OPEN_WEB_POLICY,
  SPRITE_NAME_MAX,
  SPRITE_SYNC_DEFAULT_BYTES,
  spriteName,
  spriteSandboxes,
  type SpriteClientLike,
  type SpriteCommandLike,
  type SpriteExecResult,
  type SpriteLike,
  type SpriteSandboxOptions,
} from "./provider";

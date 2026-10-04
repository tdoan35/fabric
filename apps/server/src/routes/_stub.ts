import type { Context } from "hono";
import type { ApiError } from "@fabric/contracts";

/** CP-0 placeholder: the route exists, its owner hasn't implemented it yet. */
export const notImplemented = (owner: string) => (c: Context) =>
  c.json({ error: "not implemented", owner } satisfies ApiError, 501);

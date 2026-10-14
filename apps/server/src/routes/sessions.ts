// S5 (ANY-54) session command routes — RED stub. Handlers land in the green
// commit; the empty router makes the B-cases fail on status assertions.
import { Hono } from "hono";

export const sessions = new Hono();

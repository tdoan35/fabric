// network.fetch (§5.3 TOOLS 5): the agent's policy plus the domain allowlist (the same egress
// list the Sprite enforces). Anything off the list emits tool.denied — the blocked fetch the
// Inspector's Tools tab shows.
import { z } from "zod";
import type { ToolPolicy } from "@fabric/contracts";
import { egressAllowed } from "../sprites";
import { makeTool } from "../tool-context";
import type { ToolCtx } from "../tool-context";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY = 64 * 1024;

export function networkFetchTool(policy: ToolPolicy, ctx: ToolCtx) {
  return makeTool(
    {
      name: "network.fetch",
      description: "Fetch one URL. Only the package index and the model host are reachable.",
      inputSchema: z.object({
        url: z.string().url().describe("The http(s) URL to fetch"),
      }),
      policy,
      summary: (i) => i.url.slice(0, 120),
      target: (i) => new URL(i.url).host,
      blockedReason: "not on the egress list",
      run: async (i, io) => {
        const host = new URL(i.url).host;
        if (!egressAllowed(host)) {
          await io.denied("network.fetch", host, "not on the egress list");
          return { status: 0, error: `${host} is not on the egress list` };
        }
        const res = await fetch(i.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
        const body = (await res.text()).slice(0, MAX_BODY);
        return { status: res.status, contentType: res.headers.get("content-type") ?? "", body };
      },
    },
    ctx,
  );
}

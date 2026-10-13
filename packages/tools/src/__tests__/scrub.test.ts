// ANY-70 T5 — the scrubbing backstop (D3): every known secret value, its
// base64 and its URL-encoded form become [redacted:<name>] in tool output
// lines and tool error strings, whatever ToolPort is wrapped.
import { expect, test } from "vitest";
import { z } from "zod";
import { createRegistry, defineTool } from "../index";
import { makeScrubber, withScrubbing } from "../broker";

const SECRET = "ghp_scrub_me_value_2468";
const SHORT = "abc1234"; // 7 chars: below the 8-char floor

test("B12 the scrubber replaces the value, its base64 and its URL-encoding; short values are left alone", () => {
  const scrub = makeScrubber([
    { name: "github_pat", value: SECRET },
    { name: "tiny", value: SHORT },
  ]);

  expect(scrub(`token=${SECRET}!`)).toBe("token=[redacted:github_pat]!");
  expect(scrub(`b64 ${Buffer.from(SECRET, "utf8").toString("base64")} end`)).toBe(
    "b64 [redacted:github_pat] end"
  );
  expect(scrub(`url ${encodeURIComponent(SECRET)} end`)).toBe(
    "url [redacted:github_pat] end"
  );
  expect(scrub(`short ${SHORT} stays`)).toBe(`short ${SHORT} stays`);
  expect(scrub("nothing to see")).toBe("nothing to see");
});

test("B13 withScrubbing scrubs every onLine line and every error string of a wrapped ToolPort", async () => {
  const scrub = makeScrubber([{ name: "github_pat", value: SECRET }]);
  const leaky = defineTool({
    name: "leaky",
    description: "prints and throws the secret",
    parameters: z.object({}),
    effect: "read",
    gate: "none",
    kind: "read",
    step: 0,
    execute: async (_args, ctx) => {
      ctx.onLine(`auth with ${SECRET}`);
      throw new Error(`call failed with ${SECRET}`);
    },
  });
  const port = withScrubbing(
    createRegistry([leaky]).toolPort({ workspaceId: "ws", streamId: "run:x", agentId: "a" }),
    scrub
  );

  const lines: string[] = [];
  const result = await port.run("leaky", {}, { onLine: (line) => lines.push(line) });

  expect(lines).toEqual(["auth with [redacted:github_pat]"]);
  expect(result).toEqual({ ok: false, error: "call failed with [redacted:github_pat]" });
  expect(JSON.stringify(result)).not.toContain(SECRET);

  const bare = createRegistry([leaky]).toolPort({ workspaceId: "ws", streamId: "run:x", agentId: "a" });
  const unwrapped = await bare.run("leaky", {}, {});
  expect(unwrapped.error).toContain(SECRET); // the scrub is the wrapper's doing
});

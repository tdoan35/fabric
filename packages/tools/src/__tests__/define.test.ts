// ANY-67 R1 — the name rule. `^[a-z][a-z0-9_]*$` is provider-safe, so it is
// used verbatim as the model's tool name and in DecideDef.tools; defineTool
// enforces it at define time, naming the pattern in every rejection.
import { expect, test } from "vitest";
import { defineTool } from "../index";
import { webSearchSpec } from "./fixtures";

test('R1 defineTool throws for "web.search", "WebSearch", "" and "1tool", each message naming the pattern; it accepts "web_search" frozen', () => {
  for (const name of ["web.search", "WebSearch", "", "1tool"]) {
    expect(() => defineTool({ name, ...webSearchSpec })).toThrow(
      /\^\[a-z\]\[a-z0-9_\]\*\$/
    );
  }

  const accepted = defineTool({ name: "web_search", ...webSearchSpec });
  expect(accepted.name).toBe("web_search");
  expect(Object.isFrozen(accepted)).toBe(true);
});

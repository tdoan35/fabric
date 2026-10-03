// RUN-7: derived segments equal the fixture's precomputed ones, for every mock loop.
import { describe, expect, it } from "vitest";
import { deriveSegments } from "../derive";
import { run as run135 } from "@fabric/fixtures/run";
import { runEventsById, runs } from "@fabric/fixtures/work";

describe("deriveSegments (RUN-7)", () => {
  it("the 135M fixture's derived segments equal its precomputed ones", () => {
    expect(deriveSegments(runEventsById[run135.id], run135.durationS)).toEqual(run135.segments);
  });

  // The 135M fixture's order is start order (the RUN-7 test above); the 360M fixture groups
  // segments per agent, so compare those as sets keyed by (start, agentId).
  it.each(runs.filter((r) => r.id !== run135.id).map((r) => [r.id as string, r]))(
    "%s: derived segments equal its precomputed ones",
    (_id, run) => {
      const byStart = (a: { start: number; agentId: string }, b: { start: number; agentId: string }) =>
        a.start - b.start || a.agentId.localeCompare(b.agentId);
      expect([...deriveSegments(runEventsById[run.id], run.durationS)].sort(byStart)).toEqual([...run.segments].sort(byStart));
    },
  );

  it("an open step closes at the fallback end (a running loop's now)", () => {
    const derived = deriveSegments(
      [
        { t: 0, type: "step.started", actorAgentId: "elliot", payload: { label: "Plan", stage: "Plan", kind: "work" } },
        { t: 5, type: "agent.message", actorAgentId: "elliot", payload: { text: "…" } },
      ],
      42,
    );
    expect(derived).toEqual([{ agentId: "elliot", label: "Plan", stage: "Plan", start: 0, end: 42, kind: "work" }]);
  });

  it("a finish without a start is ignored (a splice window can cut one off)", () => {
    expect(
      deriveSegments([{ t: 9, type: "step.finished", actorAgentId: "megan", payload: { label: "Survey", stage: "Prepare", kind: "work" } }], 10),
    ).toEqual([]);
  });
});

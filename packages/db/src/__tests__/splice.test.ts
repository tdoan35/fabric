// D5 splice seam: at splice_t every lane hands over to the recording's state, so no lane goes
// missing (a recording step already open) and none stretches to the end (a live step left open).
import { describe, expect, it } from "vitest";
import type { RunEvent } from "@fabric/contracts";
import { deriveSegments } from "../derive";
import { openStepsAt, spliceEvents } from "../splice";
import { run as run135 } from "@fabric/fixtures/run";
import { runEventsById } from "@fabric/fixtures/work";

const recording = runEventsById[run135.id];
const step = (t: number, type: "step.started" | "step.finished", agent: string, label: string, stage: string): RunEvent => ({
  runId: "live", seq: 0, t, type, actorAgentId: agent, payload: { label, stage, kind: "work" },
});
const started: RunEvent = { runId: "live", seq: 1, t: 0, type: "run.started", payload: { objective: "o" } };
const finished = (t: number): RunEvent => ({ runId: "live", seq: 99, t, type: "run.finished", payload: { reportId: "r" } });

describe("spliceEvents (D5)", () => {
  const T = 39;
  const openInRecording = openStepsAt(recording, T);

  it("the 135M recording has steps open at the splice point (the case this guards)", () => {
    expect(openInRecording.size).toBeGreaterThan(0);
  });

  it("a live run with no steps (TEAM not running) still shows every recording step open at t", () => {
    const merged = spliceEvents([started], recording, T, "live");
    const segments = deriveSegments(merged, run135.durationS);
    for (const [agent, s] of openInRecording) {
      expect(segments.some((seg) => seg.agentId === agent && seg.label === s.label && seg.start === T)).toBe(true);
    }
    // Nothing is left open past the recording's end.
    expect(segments.every((seg) => seg.end < run135.durationS || recording.some((e) => e.t === seg.end))).toBe(true);
  });

  it("a live step the recording has already finished closes at t", () => {
    const live = [started, step(2, "step.started", "megan", "Live survey", "Prepare")];
    const segments = deriveSegments(spliceEvents(live, recording, T, "live"), run135.durationS);
    const megan = segments.filter((s) => s.agentId === "megan");
    expect(megan[0]).toMatchObject({ label: "Live survey", start: 2, end: T });
    expect(megan.every((s) => s.end < run135.durationS)).toBe(true);
  });

  it("the same step open in both stays one continuous segment from its live start", () => {
    const [agent, s] = [...openInRecording][0];
    const live = [started, step(1, "step.started", agent, s.label, s.stage)];
    const merged = spliceEvents(live, recording, T, "live");
    expect(merged.filter((e) => e.t === T && e.actorAgentId === agent && e.type.startsWith("step."))).toEqual([]);
    const first = deriveSegments(merged, run135.durationS).find((seg) => seg.agentId === agent)!;
    expect(first.start).toBe(1);
    expect(first.end).toBeGreaterThan(T);
  });

  it("only finalize's run.finished follows the splice point; seqs run 1..N", () => {
    const late = step(50, "step.started", "jonah", "Late", "Implement");
    const merged = spliceEvents([started, late, finished(run135.durationS)], recording, T, "live");
    expect(merged.some((e) => e.type === "step.started" && e.payload.label === "Late")).toBe(false);
    expect(merged.at(-1)?.type).toBe("run.finished");
    expect(merged.filter((e) => e.type === "run.finished")).toHaveLength(1);
    expect(merged.map((e) => e.seq)).toEqual(merged.map((_, i) => i + 1));
    expect(merged.every((e) => e.runId === "live")).toBe(true);
  });
});

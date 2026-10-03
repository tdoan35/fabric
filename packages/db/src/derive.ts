// Segment derivation (RUN-7): the loop view's lanes come from step.started/step.finished events,
// never from stored segments. Pure — unit-tested against the 135M fixture's precomputed ones.
import type { RunEvent, RunSegment, SegmentKind } from "@fabric/contracts";

type StepEvent = Pick<RunEvent, "t" | "type" | "actorAgentId" | "payload">;

const stepFields = (payload: Record<string, unknown>): { label: string; stage: string; kind: SegmentKind } => {
  const label = typeof payload.label === "string" ? payload.label : "";
  const stage = typeof payload.stage === "string" ? payload.stage : "";
  const kind = (["work", "rework", "bounce", "wait", "blocked"] as const).includes(payload.kind as SegmentKind)
    ? (payload.kind as SegmentKind)
    : "work";
  return { label, stage, kind };
};

/**
 * Pairs each agent's step.started with its next step.finished, in log order.
 * A step still open at the end closes at `fallbackEnd` (a running loop's "now").
 */
export function deriveSegments(events: StepEvent[], fallbackEnd: number): RunSegment[] {
  const open = new Map<string, { label: string; stage: string; kind: SegmentKind; start: number; ord: number }>();
  const closed: (RunSegment & { ord: number })[] = [];
  let ord = 0;
  for (const e of events) {
    if (e.type !== "step.started" && e.type !== "step.finished") continue;
    const agentId = e.actorAgentId ?? "";
    const step = stepFields(e.payload);
    if (e.type === "step.started") {
      open.set(agentId, { ...step, start: e.t, ord: ord++ });
    } else {
      const started = open.get(agentId);
      if (!started) continue; // a finish without a start (e.g. cut off by a splice window)
      open.delete(agentId);
      closed.push({ agentId, label: started.label, stage: started.stage, start: started.start, end: e.t, kind: started.kind, ord: started.ord });
    }
  }
  for (const [agentId, started] of open) {
    closed.push({ agentId, label: started.label, stage: started.stage, start: started.start, end: fallbackEnd, kind: started.kind, ord: started.ord });
  }
  return closed.sort((a, b) => a.ord - b.ord).map(({ ord: _ord, ...s }) => s);
}



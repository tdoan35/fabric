// The merged log of a spliced run (D5), as a pure function so it can be unit-tested.
// Live events up to splice_t, then the recording's events after it, re-stamped with the live run's
// id; the recording's own run.finished is dropped in favour of finalize's, which always lands last.
//
// At splice_t each agent's lane hands over to the recording's state, so lanes stay continuous:
// - a live step the recording doesn't have open at splice_t is closed there (otherwise nothing
//   would ever close it, and its lane would stretch to the end of the run);
// - a recording step already open at splice_t is opened there (otherwise its start falls before the
//   splice point, its finish closes nothing, and the lane and its stage go missing).
// A step open in both with the same label and stage stays one continuous segment.
import type { RunEvent } from "@fabric/contracts";

type Step = { label: string; stage: string; kind: string };

const stepOf = (e: RunEvent): Step => ({
  label: String(e.payload.label ?? ""),
  stage: String(e.payload.stage ?? ""),
  kind: String(e.payload.kind ?? "work"),
});

/** Each agent's open step after replaying `events` up to and including `t`, in log order. */
export function openStepsAt(events: RunEvent[], t: number): Map<string, Step> {
  const open = new Map<string, Step>();
  for (const e of events) {
    if (e.t > t) continue;
    const agent = e.actorAgentId ?? "";
    if (e.type === "step.started") open.set(agent, stepOf(e));
    else if (e.type === "step.finished") open.delete(agent);
  }
  return open;
}

const sameStep = (a: Step, b: Step) => a.label === b.label && a.stage === b.stage;

export function spliceEvents(live: RunEvent[], recording: RunEvent[], spliceT: number, runId: string): RunEvent[] {
  const head = live.filter((e) => e.t <= spliceT);
  // Only finalize's run.finished may follow the splice point; a late live emit that slipped past
  // the RunClosedError guard never reaches the merged log.
  const tail = live.filter((e) => e.t > spliceT && e.type === "run.finished");
  const rec = recording.filter((e) => e.t > spliceT && e.type !== "run.finished");

  const liveOpen = openStepsAt(head, spliceT);
  const recOpen = openStepsAt(recording, spliceT);
  const bridge = (type: "step.started" | "step.finished", agent: string, step: Step): RunEvent => ({
    runId, seq: 0, t: spliceT, type, actorAgentId: agent || undefined, payload: { ...step },
  });
  const closes: RunEvent[] = [];
  const opens: RunEvent[] = [];
  for (const [agent, step] of liveOpen) {
    const next = recOpen.get(agent);
    if (!next || !sameStep(step, next)) closes.push(bridge("step.finished", agent, step));
  }
  for (const [agent, step] of recOpen) {
    const current = liveOpen.get(agent);
    if (!current || !sameStep(current, step)) opens.push(bridge("step.started", agent, step));
  }

  // Re-stamp the whole log 1..N so seqs stay contiguous however t order and seq order interleaved.
  return [head, closes, opens, rec, tail]
    .flat()
    .map((e, i) => ({ ...e, runId, seq: i + 1 }));
}

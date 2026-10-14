// The timer and stall rules (RUNTIME section 7): what a `run.timer` firing
// means, and the timers every decide arms. Pure, like the rest of decide —
// `now` is an argument, every key derives from the state, the output is
// recorded never replayed (section 2).
//
// The `run.timer` id grammar, after `<stream>:timer:`:
//   `wait:<turn>:<call>`              a wait's deadline (R9a's ask_user timer)
//   `wait:<turn>:<call>:reminder:<n>` the wait's n-th reminder
//   `watchdog:h<seq>`                 the stall watchdog's first check
//   `watchdog:h<seq>:s2`              its second check, one window later
//   `budget`                          the run's time budget
// The knobs ride the definition record: `stallAfterMs` and `askReminders` at
// the top level, the time budget as `budget.timeS` — the same place the
// run's other limits live.
import type { AgentState, Definition } from "../fold/fold";
import type { DecideJob, Decision } from "./decide";

/** What a fired `run.timer` asks about, parsed from its key by `parseTimerTrigger`. */
export type TimerTrigger =
  | { kind: "wait-deadline"; waitId: string }
  | { kind: "wait-reminder"; waitId: string }
  | { kind: "watchdog"; /** The stream head the armed check froze. */ armedHead: number; strike: 1 | 2 }
  | { kind: "budget" };

const EMPTY: Decision = { events: [], jobs: [] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The timer knobs of a definition record; absent ones arm nothing. */
export function timerKnobs(def: Definition): {
  stallAfterMs?: number;
  askReminders?: readonly number[];
  timeS?: number;
} {
  const record = isRecord(def) ? def : {};
  const budget = isRecord(record.budget) ? record.budget : {};
  return {
    ...(typeof record.stallAfterMs === "number" ? { stallAfterMs: record.stallAfterMs } : {}),
    ...(Array.isArray(record.askReminders)
      ? { askReminders: record.askReminders.filter((ms): ms is number => typeof ms === "number") }
      : {}),
    ...(typeof budget.timeS === "number" ? { timeS: budget.timeS } : {}),
  };
}

/** The trigger a `run.timer` key carries; null for a foreign or malformed id. */
export function parseTimerTrigger(streamId: string, key: string): TimerTrigger | null {
  const prefix = `${streamId}:timer:`;
  if (!key.startsWith(prefix)) return null;
  const id = key.slice(prefix.length);

  if (id === "budget") return { kind: "budget" };

  const watchdog = /^watchdog:h(\d+)(:s2)?$/.exec(id);
  if (watchdog !== null) {
    return { kind: "watchdog", armedHead: Number(watchdog[1]), strike: watchdog[2] === undefined ? 1 : 2 };
  }

  if (id.startsWith("wait:")) {
    const reminder = /^(.+):reminder:(\d+)$/.exec(id);
    if (reminder !== null) return { kind: "wait-reminder", waitId: reminder[1] };
    return { kind: "wait-deadline", waitId: id };
  }

  return null;
}

const isTerminal = (state: AgentState): boolean =>
  state.status === "blocked" || state.status === "finished" || state.status === "stopped";

/**
 * The arms `decideAgent` hangs on its decision, from the state and definition
 * it already holds (RUNTIME section 7):
 *
 * - every wait the decision opened gets a reminder timer per the definition's
 *   `askReminders` (ms before the deadline), the deadline timer itself being
 *   the ask rule's (R9a);
 * - a running stream with a `stallAfterMs` window arms the stall watchdog on
 *   its head — the next fact arms a later head, so the stale check no-ops;
 * - a run with a `budget.timeS` arms its one-shot time budget, keyed fixed so
 *   the first decide's runAt is the one that sticks.
 */
export function armTimers(state: AgentState, streamId: string, decision: Decision, now: number): Decision {
  const knobs = timerKnobs(state.def);
  const jobs: DecideJob[] = [];

  for (const event of decision.events) {
    if (event.type !== "human.requested") continue;
    const payload = event.payload as { waitId?: unknown; deadline?: unknown };
    if (typeof payload.waitId !== "string" || typeof payload.deadline !== "number") continue;
    const reminders = knobs.askReminders ?? [];
    for (let index = 0; index < reminders.length; index += 1) {
      const at = payload.deadline - reminders[index]!;
      if (at <= now) continue; // the window has already passed
      jobs.push({
        type: "run.timer",
        key: `${streamId}:timer:${payload.waitId}:reminder:${index}`,
        streamId,
        runAt: at,
      });
    }
  }

  if (typeof knobs.stallAfterMs === "number" && state.status === "running") {
    jobs.push({
      type: "run.timer",
      key: `${streamId}:timer:watchdog:h${state.head}`,
      streamId,
      runAt: now + knobs.stallAfterMs,
    });
  }

  const isRunStream = streamId.startsWith("run:");
  if (typeof knobs.timeS === "number" && isRunStream && !isTerminal(state)) {
    jobs.push({
      type: "run.timer",
      key: `${streamId}:timer:budget`,
      streamId,
      runAt: now + knobs.timeS * 1_000,
    });
  }

  return jobs.length === 0 ? decision : { events: decision.events, jobs: [...decision.jobs, ...jobs] };
}

/**
 * A fired `run.timer`'s decision (RUNTIME section 7). The deadline's expiry is
// the respond check — the firing itself observes only, and a reminder reminds
// without closing anything. The watchdog re-queues the in-flight work a stuck
// stream lost, then blocks the run that is still stuck a window later; the
// time budget blocks a run still going at `startedAt + timeS`.
 */
export function decideTimer(state: AgentState, streamId: string, trigger: TimerTrigger, now: number): Decision {
  if (isTerminal(state)) return EMPTY;

  switch (trigger.kind) {
    case "wait-deadline":
      // Expiry is enforced by `respond` against the wait's deadline; a firing
      // after the answer is the no-op T2 pins.
      return EMPTY;

    case "wait-reminder": {
      const wait = state.waits.get(trigger.waitId);
      if (wait === undefined || wait.deadline === null || now >= wait.deadline) return EMPTY;
      return {
        events: [
          {
            type: "run.progress",
            payload: { text: `reminder: ${wait.prompt}`, milestone: "reminder" },
          },
        ],
        jobs: [],
      };
    }

    case "watchdog": {
      if (state.status === "waiting") return EMPTY; // its deadline timer governs the wait
      if ((state.head ?? 0) > trigger.armedHead) return EMPTY; // progress since the arm
      if (trigger.strike === 2) {
        return {
          events: [{ type: "run.blocked", payload: { reason: "stall" } }],
          jobs: [],
        };
      }
      // strike one: requeue the in-flight work under its ordinary key — a live
      // lease dedupes, a lost job returns — and arm the second check.
      const jobs: DecideJob[] = [];
      for (const callId of state.openToolCalls.keys()) {
        jobs.push({ type: "tool.exec", key: `${streamId}:${callId}`, streamId });
      }
      const last = state.lastFact;
      if (last?.type === "llm.requested") {
        const payload = last.payload as { turn?: unknown; callNo?: unknown };
        if (typeof payload.turn === "number" && typeof payload.callNo === "number") {
          jobs.push({ type: "llm.call", key: `${streamId}:${payload.turn}:llm:${payload.callNo}`, streamId });
        }
      }
      const window = timerKnobs(state.def).stallAfterMs ?? 0;
      jobs.push({
        type: "run.timer",
        key: `${streamId}:timer:watchdog:h${trigger.armedHead}:s2`,
        streamId,
        runAt: now + window,
      });
      return { events: [], jobs };
    }

    case "budget":
      return {
        events: [{ type: "run.blocked", payload: { reason: "budget_time" } }],
        jobs: [],
      };
  }
}

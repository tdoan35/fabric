// The legacy-engine bridges (ANY-58 S8b): Dana keeps the team handoff and the
// browser errand on the agent loop by bridging into today's engines through
// `tool.exec`. Both are `once` effects — each starts a run — so a retried job
// with no recorded result follows R9b's once recovery (`tool.interrupted` plus
// the human "check whether this happened") instead of ever starting a second
// run; the runs' results reach the session through the S10 stream, not the
// tool result. The dispositions ride the def extension below (S2's
// dispositionKinds): a handoff turn is `team` (the team id from the call),
// an errand turn `agent` (target `browser`) — stated by the model or derived.
//
// The legacy engines are replaced for real in ANY-42 (errand as an agent run)
// and ANY-43 (the team loop); until then `legacyBridges` binds them exactly as
// the assistant's own path does — same dep shapes, same fallbacks, nothing in
// assistant/handoff.ts, assistant/errand.ts or services/runtime.ts changed.
// The tests stub the two engine seams (`handoff` / `errand` below), which is
// those modules' boundary as the bridge sees it.
import { NotImplementedError } from "@fabric/contracts";
import type { AppEvent } from "@fabric/contracts";
import type { Db, RunWriter } from "@fabric/db";
import type { TeamRuntime } from "../../team";
import { compileBrief, deterministicBrief } from "../../context";
import { model } from "../../llm";
import { runHandoff } from "../handoff";
import type { HandoffDeps } from "../handoff";
import { runErrand } from "../errand";
import { errandContext } from "../errand-context";
import { getSession } from "../store";
import type { ToolSchema } from "./definition";
import { sessionOf } from "./proposals";

/** The bridge tools, in declaration order. */
export const BRIDGE_TOOLS = ["handoff_to_team", "browser_task"] as const;
export type BridgeTool = (typeof BRIDGE_TOOLS)[number];

/** The declarations the model sees; the `once` effect lives in the def
 * extension's toolEffects and the port's descriptors alike. */
export const BRIDGE_TOOL_SCHEMAS: Record<BridgeTool, { description: string; parameters: Record<string, unknown> }> = {
  handoff_to_team: {
    description:
      "Hand the work to an approved team: compiles the brief, creates the task and starts the run. Ends your turn; the run's results arrive in the thread.",
    parameters: {
      type: "object",
      properties: {
        teamId: { type: "string", description: "The team's id (or name), from the registry." },
        request: {
          type: "string",
          description: "Your one-sentence restatement of the request — the only text the brief compiler sees.",
        },
        title: { type: "string", description: "Short task title for the Work board." },
      },
      required: ["teamId", "request"],
    },
  },
  browser_task: {
    description:
      "Handle a browser errand directly: bounded private browser loop, ONE compact result. A booking request authorizes real submission.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The errand, in a sentence or two." },
        startUrl: { type: "string", description: "Where to begin, when it is not the obvious first page." },
        facts: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Key/value facts (from recall) the errand needs.",
        },
      },
      required: ["goal"],
    },
  },
};

/** The def extension: the bridge tools on the loop, their `once` effects and
 * the S2 disposition kinds. Applied through `withBridges` — the base definition
 * stays untouched. */
export const BRIDGE_DEF_EXTENSION = {
  tools: [...BRIDGE_TOOLS],
  toolSchemas: BRIDGE_TOOLS.map((name) => ({ name, ...BRIDGE_TOOL_SCHEMAS[name] })) as ToolSchema[],
  toolEffects: { handoff_to_team: "once", browser_task: "once" },
  dispositionKinds: {
    handoff_to_team: { kind: "team", targetArg: "teamId" },
    browser_task: { kind: "agent", target: "browser" },
  },
} as const;

type BridgeDefInput = {
  tools?: readonly string[];
  toolSchemas?: readonly unknown[];
  toolEffects?: Record<string, unknown>;
  dispositionKinds?: Record<string, unknown>;
};

/** Returns the definition with the bridge tools merged in — idempotent, the
 * base's own entries always win their slots. A session without the bridges
 * (the placeholder agents) passes through unchanged in content. */
export function withBridges<D extends BridgeDefInput>(def: D): D {
  const tools = [...(def.tools ?? [])];
  for (const name of BRIDGE_DEF_EXTENSION.tools) if (!tools.includes(name)) tools.push(name);
  const schemas = [...(def.toolSchemas ?? [])];
  const schemaNames = new Set(schemas.map((schema) => (schema as { name?: string }).name));
  for (const schema of BRIDGE_DEF_EXTENSION.toolSchemas) {
    if (!schemaNames.has(schema.name)) schemas.push(schema);
  }
  return {
    ...def,
    tools,
    toolSchemas: schemas,
    toolEffects: { ...(def.toolEffects ?? {}), ...BRIDGE_DEF_EXTENSION.toolEffects },
    dispositionKinds: { ...(def.dispositionKinds ?? {}), ...BRIDGE_DEF_EXTENSION.dispositionKinds },
  } as D;
}

/** The io a bridge call carries: the loop-scoped ids the engines key off. */
export type BridgeCallIo = { callId?: string; streamId?: string };

export type HandoffBridgeInput = { teamId: string; request: string; title?: string };
export type ErrandBridgeInput = { goal: string; startUrl?: string; facts?: Record<string, string> };

/** The legacy engines, as the bridge calls them: the modules' boundary. The
 * production binding is `legacyBridges`; tests stub these two functions. */
export type SessionBridgeEngines = {
  handoff: (input: HandoffBridgeInput, io: BridgeCallIo) => Promise<{ runId: string }>;
  errand: (input: ErrandBridgeInput, io: BridgeCallIo) => Promise<{ runId: string }>;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The `handoff_to_team` / `browser_task` bodies on the session ToolPort: the
 * one legacy-engine call, the brief/goal passed through as the model stated it,
 * and `{ runId }` as the result — nothing more, the engines own the rest.
 */
export async function runBridgeTool(
  name: string,
  args: Record<string, unknown>,
  io: BridgeCallIo,
  bridges: SessionBridgeEngines,
): Promise<{ ok: boolean; result?: { runId: string }; error?: string }> {
  try {
    if (name === "handoff_to_team") {
      const { teamId, request, title } = args as Record<string, unknown>;
      if (typeof teamId !== "string" || teamId === "")
        return { ok: false, error: "handoff_to_team needs the team id" };
      if (typeof request !== "string" || request === "")
        return { ok: false, error: "handoff_to_team needs the request text" };
      const { runId } = await bridges.handoff(
        {
          teamId,
          request,
          ...(typeof title === "string" && title !== "" ? { title } : {}),
        },
        io,
      );
      if (typeof runId !== "string" || runId === "") return { ok: false, error: "the handoff returned no run id" };
      return { ok: true, result: { runId } };
    }
    if (name === "browser_task") {
      const { goal, startUrl, facts } = args as Record<string, unknown>;
      if (typeof goal !== "string" || goal === "") return { ok: false, error: "browser_task needs a goal" };
      const { runId } = await bridges.errand(
        {
          goal,
          ...(typeof startUrl === "string" && startUrl !== "" ? { startUrl } : {}),
          ...(facts !== undefined && typeof facts === "object" && !Array.isArray(facts)
            ? { facts: facts as Record<string, string> }
            : {}),
        },
        io,
      );
      if (typeof runId !== "string" || runId === "") return { ok: false, error: "the errand returned no run id" };
      return { ok: true, result: { runId } };
    }
    return { ok: false, error: `unknown bridge tool: ${name}` };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/** The app-side runtime the legacy engines need — `services/runtime.ts`'s
 * Runtime, structurally, so the server binds without a type dependency. */
export type LegacyAppRuntime = {
  db: Db;
  writer: RunWriter;
  /** Undefined until TEAM lands; the bound stub throws only on use. */
  team: () => TeamRuntime | undefined;
};

/** The production engines: today's handoff and errand paths, bound once per
 * call to the app runtime (resolved lazily — a bridge runs long after boot).
 * The brief is the live compiler with the deterministic fallback, the errand
 * key is the tool call id, so a redelivered bridge lands on the same
 * operation the errand's own dedupe guards. */
export function legacyBridges(legacy: {
  app: () => LegacyAppRuntime;
  publish: (e: AppEvent) => void;
  /** DEMO_RECORDING_KEY: what a Fast-forward splices into after the handoff. */
  recordingKey?: string;
}): SessionBridgeEngines {
  const team = (): TeamRuntime =>
    legacy.app().team() ?? {
      // DANA can land before TEAM: the stand-in throws only if a run starts.
      async startTeamRun() {
        throw new NotImplementedError("TEAM", "startTeamRun");
      },
      async cancelRun() {
        throw new NotImplementedError("TEAM", "cancelRun");
      },
    };

  const handoffDeps = (): HandoffDeps => ({
    db: legacy.app().db,
    writer: legacy.app().writer,
    team: team(),
    publish: legacy.publish,
    recordingKey: legacy.recordingKey ?? "ngram-135m", // the assistant's default
    // The live brief falls back to the deterministic one, exactly as the
    // assistant's own handoff path does (ARCH §11).
    brief: async (input) => {
      try {
        return await compileBrief(input);
      } catch (err) {
        console.log(`[session-bridges] compileBrief failed (${errorText(err)}); using the deterministic brief`);
        return deterministicBrief(input);
      }
    },
  });

  return {
    handoff: async (input, io) => {
      const sessionId = sessionOf(io.streamId);
      if (sessionId === null) throw new Error("handoff_to_team needs a session stream");
      const payload = await runHandoff(handoffDeps(), {
        sessionId,
        session: await getSession(legacy.app().db, sessionId),
        teamName: input.teamId, // getTeamByName matches ids and slug ids alike
        request: input.request,
        ...(input.title !== undefined ? { title: input.title } : {}),
      });
      return { runId: payload.runId };
    },

    errand: async (input, io) => {
      const sessionId = sessionOf(io.streamId);
      if (sessionId === null) throw new Error("browser_task needs a session stream");
      const result = await runErrand(
        {
          goal: input.goal,
          ...(input.startUrl !== undefined ? { startUrl: input.startUrl } : {}),
          ...(input.facts !== undefined ? { facts: input.facts } : {}),
        },
        {
          db: legacy.app().db,
          writer: legacy.app().writer,
          publish: legacy.publish,
          sessionId,
          operationKey: io.callId ?? `bridge:${io.streamId ?? "none"}`,
          // The outer context the loop cannot reconstruct; the errand's own
          // inner loop works from the goal (see errand.ts).
          snapshot: errandContext("Dana's browser errand, handed off from the session loop.", []),
          browser: (runId) => ({
            model: model(process.env.BROWSER_MODEL || "Haiku 4.5", {
              thinking: "off",
              meter: { runId, agentId: "dana", step: "browser" },
            }),
          }),
        },
      );
      return { runId: result.runId };
    },
  };
}

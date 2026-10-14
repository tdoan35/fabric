// ANY-72 W11 — `tool.exec` passes the `tool.call`'s callId into the port's io
// (RUNTIME §6: the idempotency key a `once` tool derives). A recording port
// sees `{ onLine, callId }` with the call's id, on the PGlite driver.
import { expect, test } from "vitest";
import { append, type EventInput } from "../../index";
import { MemoryQueue } from "../../queue/memory";
import type { ToolPort, ToolRunResult } from "../../ports";
import type { RuntimeStore } from "../../store/types";
import { describeDrivers } from "../../testing/drivers";
import { handleToolExecJob } from "../../workers/tool-exec";

const WORKSPACE = "ws-w11";
const STREAM = "run:w11";
const CALL_ID = "call-77";

const runCreated: EventInput = {
  type: "run.created",
  actor: "api",
  payload: {
    definition: { systemPrompt: "SYS", tools: ["notify"] },
    engineVersion: "v1",
    brief: "",
    grants: ["notify"],
    budgets: {},
    parent: null,
  },
};

const toolCalled: EventInput = {
  type: "tool.call",
  actor: "decide",
  payload: { tool: "notify", summary: "send it", callId: CALL_ID, args: {}, effect: "once" },
};

/** A port that records the exact io spread each run received. */
const portWith = (seen: Array<Record<string, unknown>>): ToolPort => ({
  async run(_name, _args, io) {
    seen.push({ ...io });
    const result: ToolRunResult = { ok: true, result: "sent" };
    return result;
  },
  describe: () => undefined,
});

async function seed(store: RuntimeStore, events: readonly EventInput[]) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId: STREAM, events }]));
}

describeDrivers("tool.exec passes callId in io (ANY-72 W11)", (h) => {
  test("W11 the port's io carries the tool.call's callId next to onLine", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const seen: Array<Record<string, unknown>> = [];
    const tools = portWith(seen);

    await seed(store, [runCreated, toolCalled]);
    await store.transaction((tx) =>
      queue.enqueue(tx, {
        type: "tool.exec",
        key: `${STREAM}:${CALL_ID}`,
        streamId: STREAM,
        workspaceId: WORKSPACE,
      })
    );
    const lease = await queue.claim("worker-1", ["tool.exec"], 0);
    if (lease === null) throw new Error("expected a claimable tool.exec job");
    await handleToolExecJob(lease, { store, queue, tools, now: () => 0 });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.callId).toBe(CALL_ID);
    expect(typeof seen[0]?.onLine).toBe("function");
  });
});

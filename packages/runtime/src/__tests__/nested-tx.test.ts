// ANY-79 R13 — a store transaction opened inside another's callback joins it
// as a savepoint, on both drivers. Before this, a store-backed tool run by
// handleToolExecJob deadlocked on PGlite (one connection, transactions
// chained) and ran on a second connection on Postgres. Deadlock-prone calls
// race a 2 s deadline that fails as an assertion, never a test timeout.
import { AssertionError } from "node:assert";
import { expect, test } from "vitest";
import {
  append,
  handleToolExecJob,
  MemoryQueue,
  openStore,
  type EventInput,
  type RuntimeStore,
  type ToolPort,
} from "../index";
import { describeDrivers } from "../testing/drivers";

const WORKSPACE = "ws-r13";
const DEADLINE_MS = 2_000;

/** Settles like `promise`, or fails as an assertion when it hangs past the deadline. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AssertionError({ message: `deadlocked: ${what} did not settle within ${DEADLINE_MS} ms` })),
      DEADLINE_MS
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function withProbe(store: RuntimeStore): Promise<RuntimeStore> {
  await store.transaction((tx) => tx.query("create table if not exists r13_probe (id text primary key)"));
  return store;
}

const insert = "insert into r13_probe (id) values ($1)";

async function probeIds(store: RuntimeStore): Promise<string[]> {
  const rows = await store.transaction((tx) => tx.query("select id from r13_probe order by id"));
  return rows.map((row) => String(row.id));
}

describeDrivers("nested store transactions (ANY-79 R13)", (h) => {
  test("R13.1 a nested transaction resolves and sees the outer transaction's uncommitted insert", async () => {
    const store = await withProbe(await h.openStore());
    await within(
      store.transaction(async (tx) => {
        await tx.query(insert, ["outer"]);
        const rows = await within(
          store.transaction((nested) => nested.query("select id from r13_probe")),
          "the nested transaction"
        );
        expect(rows.map((row) => row.id)).toEqual(["outer"]);
      }),
      "the outer transaction"
    );
    expect(await probeIds(store)).toEqual(["outer"]);
  });

  test("R13.2 a nested throw caught by the outer undoes only the nested writes; the outer commits", async () => {
    const store = await withProbe(await h.openStore());
    await within(
      store.transaction(async (tx) => {
        await tx.query(insert, ["outer"]);
        await expect(
          within(
            store.transaction(async (nested) => {
              await nested.query(insert, ["nested"]);
              throw new Error("nested fails");
            }),
            "the nested transaction"
          )
        ).rejects.toThrow("nested fails");
        // The outer transaction is still usable after the savepoint rolled back.
        await tx.query(insert, ["outer-after"]);
      }),
      "the outer transaction"
    );
    expect(await probeIds(store)).toEqual(["outer", "outer-after"]);
  });

  test("R13.3 the nested call succeeds, then the outer throws: both sets of writes are gone", async () => {
    const store = await withProbe(await h.openStore());
    await expect(
      within(
        store.transaction(async (tx) => {
          await tx.query(insert, ["outer"]);
          await within(
            store.transaction((nested) => nested.query(insert, ["nested"])),
            "the nested transaction"
          );
          throw new Error("outer fails");
        }),
        "the outer transaction"
      )
    ).rejects.toThrow("outer fails");
    expect(await probeIds(store)).toEqual([]);
  });

  test("R13.4 nested onCommit runs once after the outer commit, never after either rollback", async () => {
    const store = await withProbe(await h.openStore());
    const order: string[] = [];

    await within(
      store.transaction(async (tx) => {
        await within(
          store.transaction(async (nested) => {
            nested.onCommit(() => order.push("nested hook"));
            await nested.query(insert, ["kept"]);
          }),
          "the nested transaction"
        );
        tx.onCommit(() => order.push("outer hook"));
        order.push("outer callback done");
      }),
      "the outer transaction"
    );
    order.push("outer resolved");
    expect(order).toEqual(["outer callback done", "nested hook", "outer hook", "outer resolved"]);

    // A nested rollback drops its hooks, though the outer commits.
    let ranAfterNestedRollback = 0;
    await within(
      store.transaction(async () => {
        await store
          .transaction(async (nested) => {
            nested.onCommit(() => (ranAfterNestedRollback += 1));
            throw new Error("nested fails");
          })
          .catch(() => undefined);
      }),
      "the outer transaction"
    );
    expect(ranAfterNestedRollback).toBe(0);

    // An outer rollback drops the hooks of a nested transaction that succeeded.
    let ranAfterOuterRollback = 0;
    await expect(
      within(
        store.transaction(async () => {
          await store.transaction(async (nested) => {
            nested.onCommit(() => (ranAfterOuterRollback += 1));
          });
          throw new Error("outer fails");
        }),
        "the outer transaction"
      )
    ).rejects.toThrow("outer fails");
    expect(ranAfterOuterRollback).toBe(0);
    expect(await probeIds(store)).toEqual(["kept"]);
  });

  test("R13.5 two nested transactions in parallel both finish; only the failing one's writes vanish", async () => {
    const store = await withProbe(await h.openStore());
    await within(
      store.transaction(async () => {
        const settled = await Promise.allSettled([
          store.transaction(async (nested) => {
            await nested.query(insert, ["a1"]);
            await new Promise((resolve) => setTimeout(resolve, 10));
            await nested.query(insert, ["a2"]);
          }),
          store.transaction(async (nested) => {
            await nested.query(insert, ["b1"]);
            throw new Error("b fails");
          }),
        ]);
        expect(settled.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      }),
      "the outer transaction with two nested ones"
    );
    expect(await probeIds(store)).toEqual(["a1", "a2"]);
  });

  test("R13.6 work that outlives its transaction starts a fresh top-level one", async () => {
    const store = await withProbe(await h.openStore());
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let later: Promise<unknown> | undefined;

    await within(
      store.transaction(async (tx) => {
        await tx.query(insert, ["outer"]);
        // Inside the callback, a nested call joins.
        await within(store.transaction((nested) => nested.query(insert, ["nested"])), "the nested transaction");
        // Scheduled here, but runs only after the outer has committed.
        later = gate.then(() => store.transaction((own) => own.query(insert, ["later"])));
      }),
      "the outer transaction"
    );
    openGate();
    await within(later as Promise<unknown>, "the later transaction");

    // An unrelated rollback afterwards leaves the later write in place.
    await expect(
      store.transaction(async (tx) => {
        await tx.query(insert, ["doomed"]);
        throw new Error("unrelated rollback");
      })
    ).rejects.toThrow("unrelated rollback");
    expect(await probeIds(store)).toEqual(["later", "nested", "outer"]);
  });

  test("R13.7 a transaction on another store never joins this one", async () => {
    const storeA = await withProbe(await h.openStore());
    const storeB = await withProbe(await openStore({ driver: "pglite" }));
    try {
      await expect(
        within(
          storeA.transaction(async (tx) => {
            await tx.query(insert, ["a-outer"]);
            // Same store: joins, and sees the uncommitted row.
            const seen = await within(
              storeA.transaction((nested) => nested.query("select id from r13_probe")),
              "the nested transaction on store A"
            );
            expect(seen.map((row) => row.id)).toEqual(["a-outer"]);
            // Other store: its own transaction, committed on its own.
            await within(storeB.transaction((own) => own.query(insert, ["b-own"])), "store B's transaction");
            throw new Error("store A rolls back");
          }),
          "store A's transaction"
        )
      ).rejects.toThrow("store A rolls back");
      expect(await probeIds(storeA)).toEqual([]);
      expect(await probeIds(storeB)).toEqual(["b-own"]);
    } finally {
      await storeB.close();
    }
  });

  test("R13.8 handleToolExecJob runs a tool that opens its own store transaction", async () => {
    const store = await h.openStore();
    const streamId = "run:r13";
    const runCreated: EventInput = {
      type: "run.created",
      actor: "api",
      payload: {
        definition: { systemPrompt: "SYS", tools: ["probe"] },
        engineVersion: "v1",
        brief: "",
        grants: ["probe"],
        budgets: {},
        parent: null,
      },
    };
    await store.transaction((tx) =>
      append(tx, WORKSPACE, [
        {
          streamId,
          events: [
            runCreated,
            { type: "tool.call", actor: "decide", payload: { tool: "probe", summary: "probe", callId: "c1", args: {} } },
          ],
        },
      ])
    );

    // A store-backed tool, like M1's skills store or the vault's encrypted table.
    const tools: ToolPort = {
      describe: (name) =>
        name === "probe" ? { name, effect: "read", description: "reads the log", parameters: {} } : undefined,
      async run() {
        const rows = await store.transaction((tx) =>
          tx.query("select type from events where stream_id = $1 and workspace_id = $2 order by seq", [
            streamId,
            WORKSPACE,
          ])
        );
        return { ok: true, result: { types: rows.map((row) => String(row.type)) } };
      },
    };

    const queue = new MemoryQueue();
    await store.transaction((tx) =>
      queue.enqueue(tx, { type: "tool.exec", key: `${streamId}:c1`, streamId, workspaceId: WORKSPACE })
    );
    const lease = await queue.claim("worker-1", ["tool.exec"], 0);
    if (lease === null) throw new Error("expected a claimable tool.exec job");

    await within(handleToolExecJob(lease, { store, queue, tools, now: () => 0 }), "handleToolExecJob");

    const completed = (await store.readStream(streamId, { workspaceId: WORKSPACE })).filter(
      (event) => event.type === "tool.completed"
    );
    expect(completed).toHaveLength(1);
    expect(completed[0].payload).toMatchObject({ callId: "c1", ok: true });
    expect((completed[0].payload as { result: { types: string[] } }).result.types).toContain("tool.call");
  });
});

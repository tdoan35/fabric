// ANY-31 R5 — the storage suite. Every case R5.1-R5.11 runs on both drivers via
// describeDrivers; R5.12 is Postgres-only (concurrency), R5.13 tests the CI guard.
import { expect, test } from "vitest";
import { parseEvent } from "@fabric/core";
import { append, type EventInput, type RuntimeTx } from "../index";
import { describeDrivers, postgresUrlFromEnv } from "../testing/drivers";

const fact = (over: Partial<EventInput> = {}): EventInput => ({
  type: "run.started",
  actor: "tester",
  payload: { objective: "objective" },
  ...over,
});

const telemetry = (over: Partial<EventInput> = {}): EventInput => ({
  type: "agent.message",
  actor: "tester",
  payload: { text: "hello" },
  ...over,
});

async function headOf(tx: RuntimeTx, streamId: string): Promise<number | undefined> {
  const rows = await tx.query("select head from streams where id = $1", [streamId]);
  return rows.length === 0 ? undefined : Number(rows[0].head);
}

describeDrivers("runtime store (ANY-31 R5)", (h) => {
  test("R5.1 appending three events to a new stream creates it with head 3 and seq 1, 2, 3", async () => {
    const store = await h.openStore();
    await store.transaction(async (tx) => {
      await append(tx, "ws-one", [{ streamId: "run:a", events: [fact(), fact(), fact()] }]);
      expect(await headOf(tx, "run:a")).toBe(3);
    });
    const events = await store.readStream("run:a", { workspaceId: "ws-one" });
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  test("R5.2 a second append of two events continues at seq 4, 5", async () => {
    const store = await h.openStore();
    await store.transaction((tx) =>
      append(tx, "ws-one", [{ streamId: "run:a", events: [fact(), fact(), fact()] }])
    );
    const result = await store.transaction((tx) =>
      append(tx, "ws-one", [{ streamId: "run:a", events: [fact(), fact()] }])
    );
    expect(result).toEqual([{ duplicate: false }]);
    const events = await store.readStream("run:a", { workspaceId: "ws-one" });
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test("R5.3 one append bumps both touched heads; a failed second stream rolls both back", async () => {
    const store = await h.openStore();
    await store.transaction((tx) =>
      append(tx, "ws-one", [
        { streamId: "run:a", events: [fact()] },
        { streamId: "run:b", events: [fact()] },
      ])
    );

    // The second stream's insert fails (undefined payload -> NOT NULL payload), after
    // the first stream's rows are already written in the same transaction.
    await expect(
      store.transaction((tx) =>
        append(tx, "ws-one", [
          { streamId: "run:a", events: [fact()] },
          { streamId: "run:b", events: [fact({ payload: undefined })] },
        ])
      )
    ).rejects.toThrow();

    expect(await store.readStream("run:a", { workspaceId: "ws-one" })).toHaveLength(1);
    expect(await store.readStream("run:b", { workspaceId: "ws-one" })).toHaveLength(1);
    await store.transaction(async (tx) => {
      expect(await headOf(tx, "run:a")).toBe(1);
      expect(await headOf(tx, "run:b")).toBe(1);
    });
  });

  test("R5.4 a fact causation already on the stream makes the batch a no-op", async () => {
    const store = await h.openStore();
    const batch = { streamId: "run:a", events: [fact({ causation: "job:1" })] };
    await store.transaction((tx) => append(tx, "ws-one", [batch]));

    const result = await store.transaction((tx) => append(tx, "ws-one", [batch]));
    expect(result).toEqual([{ duplicate: true }]);

    expect(await store.readStream("run:a", { workspaceId: "ws-one" })).toHaveLength(1);
    await store.transaction(async (tx) => {
      expect(await headOf(tx, "run:a")).toBe(1);
    });
  });

  test("R5.5 the same causation on a different stream is accepted", async () => {
    const store = await h.openStore();
    await store.transaction((tx) =>
      append(tx, "ws-one", [{ streamId: "run:a", events: [fact({ causation: "job:1" })] }])
    );
    const result = await store.transaction((tx) =>
      append(tx, "ws-one", [{ streamId: "run:b", events: [fact({ causation: "job:1" })] }])
    );
    expect(result).toEqual([{ duplicate: false }]);
    expect(await store.readStream("run:b", { workspaceId: "ws-one" })).toHaveLength(1);
  });

  test("R5.6 telemetry with a repeated causation is accepted", async () => {
    const store = await h.openStore();
    const batch = { streamId: "run:a", events: [telemetry({ causation: "job:1" })] };
    await store.transaction((tx) => append(tx, "ws-one", [batch]));
    const result = await store.transaction((tx) => append(tx, "ws-one, ", [batch]));
    expect(result).toEqual([{ duplicate: false }]);
    const events = await store.readStream("run:a", { workspaceId: "ws-one" });
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.class === "telemetry")).toBe(true);
  });

  test("R5.7 onNotify fires once per stream after commit with workspace:stream:seq; silence on rollback", async () => {
    const store = await h.openStore();
    const notes: string[] = [];
    await store.transaction((tx) =>
      append(
        tx,
        "ws-one",
        [
          { streamId: "run:a", events: [fact(), fact()] },
          { streamId: "run:b", events: [fact()] },
        ],
        { onNotify: (note) => notes.push(note) }
      )
    );
    expect(notes).toEqual(["ws-one:run:a:2", "ws-one:run:b:1"]);

    const before = notes.length;
    await expect(
      store.transaction(async (tx) => {
        await append(tx, "ws-one", [{ streamId: "run:c", events: [fact()] }], {
          onNotify: (note) => notes.push(note),
        });
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    expect(notes).toHaveLength(before);
    expect(await store.readStream("run:c", { workspaceId: "ws-one" })).toEqual([]);
  });

  test("R5.8 enqueue: one decide job per fact-bearing stream inside the tx; none from a rolled back tx", async () => {
    const store = await h.openStore();
    await store.transaction((tx) =>
      tx.query("create table jobs_seen (stream_id text not null, kind text not null)")
    );
    const enqueue = async (tx: RuntimeTx, job: { type: string; streamId: string }) => {
      await tx.query("insert into jobs_seen (stream_id, kind) values ($1, $2)", [
        job.streamId,
        job.type,
      ]);
    };

    await store.transaction((tx) =>
      append(
        tx,
        "ws-one",
        [
          { streamId: "run:a", events: [fact()] },
          { streamId: "run:b", events: [telemetry()] },
        ],
        { enqueue }
      )
    );
    const jobs = await store.transaction((tx) =>
      tx.query("select stream_id, kind from jobs_seen order by stream_id")
    );
    // run:a gained a fact -> one decide job; run:b gained only telemetry -> none.
    expect(jobs).toEqual([{ stream_id: "run:a", kind: "decide" }]);

    await expect(
      store.transaction(async (tx) => {
        await append(tx, "ws-one", [{ streamId: "run:c", events: [fact()] }], { enqueue });
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    const after = await store.transaction((tx) => tx.query("select stream_id from jobs_seen"));
    expect(after).toEqual([{ stream_id: "run:a" }]);
  });

  test("R5.9 readStream: seq order, factsOnly drops telemetry, fromSeq 3 starts at 3", async () => {
    const store = await h.openStore();
    await store.transaction((tx) =>
      append(tx, "ws-one", [
        { streamId: "run:a", events: [fact(), telemetry(), fact(), telemetry()] },
      ])
    );

    const all = await store.readStream("run:a", { workspaceId: "ws-one" });
    expect(all.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(all.map((event) => event.type)).toEqual([
      "run.started",
      "agent.message",
      "run.started",
      "agent.message",
    ]);

    const facts = await store.readStream("run:a", { workspaceId: "ws-one", factsOnly: true });
    expect(facts.map((event) => event.seq)).toEqual([1, 3]);

    const tail = await store.readStream("run:a", { workspaceId: "ws-one", fromSeq: 3 });
    expect(tail.map((event) => event.seq)).toEqual([3, 4]);
  });

  test("R5.10 a stream written under workspace A reads empty under workspace B", async () => {
    const store = await h.openStore();
    await store.transaction((tx) =>
      append(tx, "ws-one", [{ streamId: "run:a", events: [fact()] }])
    );
    expect(await store.readStream("run:a", { workspaceId: "ws-two" })).toEqual([]);
    expect(await store.readStream("run:a", { workspaceId: "ws-one" })).toHaveLength(1);
  });

  test("R5.11 stored events pass parseEvent and deep-equal what was appended", async () => {
    const store = await h.openStore();
    const inputs: EventInput[] = [
      fact({ causation: "job:1", payload: { objective: "ship it" } }),
      fact({
        type: "run.created",
        causation: null,
        payload: {
          definition: { name: "alpha" },
          engineVersion: "1",
          brief: "brief",
          grants: ["web"],
          budgets: { usd: 1 },
          parent: null,
        },
      }),
    ];
    await store.transaction((tx) =>
      append(tx, "ws-one", [{ streamId: "run:a", events: inputs }])
    );

    const events = await store.readStream("run:a", { workspaceId: "ws-one" });
    expect(events).toHaveLength(2);
    for (const [index, event] of events.entries()) {
      // The envelope is exactly what parseEvent accepts, fields included.
      expect(parseEvent(event)).toEqual(event);
      expect(event.workspaceId).toBe("ws-one");
      expect(event.streamId).toBe("run:a");
      expect(event.type).toBe(inputs[index].type);
      expect(event.actor).toBe(inputs[index].actor);
      expect(event.v).toBe(1);
      expect(event.causation).toBe(inputs[index].causation ?? null);
      expect(event.payload).toEqual(inputs[index].payload);
    }
  });

  test.skipIf(h.driver !== "postgres")(
    "R5.12 twenty concurrent single-event appends end at seq 1..20, no gaps, no duplicates",
    async () => {
      const store = await h.openStore();
      await Promise.all(
        Array.from({ length: 20 }, (_unused, index) =>
          store.transaction((tx) =>
            append(tx, "ws-one", [
              { streamId: "run:c", events: [fact({ causation: `job:${index}` })] },
            ])
          )
        )
      );
      const seqs = (await store.readStream("run:c", { workspaceId: "ws-one" })).map(
        (event) => event.seq
      );
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      expect(new Set(seqs).size).toBe(20);
    }
  );

  test("R5.13 the CI guard names RUNTIME_TEST_DATABASE_URL when CI=true and the URL is unset", () => {
    const ci = process.env.CI;
    const url = process.env.RUNTIME_TEST_DATABASE_URL;
    try {
      delete process.env.RUNTIME_TEST_DATABASE_URL;

      process.env.CI = "true";
      expect(() => postgresUrlFromEnv()).toThrow(/RUNTIME_TEST_DATABASE_URL/);

      delete process.env.CI;
      expect(postgresUrlFromEnv()).toBeUndefined();

      process.env.RUNTIME_TEST_DATABASE_URL = "postgres://postgres@localhost:5432/runtime_test";
      expect(postgresUrlFromEnv()).toBe("postgres://postgres@localhost:5432/runtime_test");
    } finally {
      if (ci === undefined) delete process.env.CI;
      else process.env.CI = ci;
      if (url === undefined) delete process.env.RUNTIME_TEST_DATABASE_URL;
      else process.env.RUNTIME_TEST_DATABASE_URL = url;
    }
  });
});

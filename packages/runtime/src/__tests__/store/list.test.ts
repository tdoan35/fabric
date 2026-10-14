// S11 (ANY-61) — the thread list: `listStreams` over the runtime store, on
// both drivers. Session streams newest first, `before` paginates, `run:` and
// other non-session kinds stay out of a `session` listing.
import { afterEach, expect, test } from "vitest";
import { append, listStreams } from "../../index";
import type { RuntimeStore } from "../../index";
import { describeDrivers } from "../../testing/drivers";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 4));

const sessionId = (): string => crypto.randomUUID();

/** One `session:` stream carrying `count` facts, appended at a distinct instant. */
const seedSession = async (
  store: RuntimeStore,
  workspace: string,
  id: string,
  count = 1
): Promise<string> => {
  const streamId = `session:${id}`;
  await store.transaction((tx) =>
    append(tx, workspace, [
      {
        streamId,
        events: Array.from({ length: count }, () => ({
          type: "session.created",
          actor: "api",
          payload: { agentId: "dana", incognito: false, surfaces: ["app"] },
        })),
      },
    ])
  );
  return streamId;
};

describeDrivers("S11 runtime: the thread list (ANY-61)", (h) => {
  let store: RuntimeStore | undefined;

  afterEach(async () => {
    store = undefined;
  });

  const open = async (): Promise<RuntimeStore> => {
    store ??= await h.openStore();
    return store;
  };

  test("I1: listStreams returns session streams newest first, paginates with before, and excludes run: streams", async () => {
    const db = await open();
    const workspace = "I1-workspace";

    const first = await seedSession(db, workspace, sessionId(), 2);
    await tick();
    const second = await seedSession(db, workspace, sessionId());
    await tick();
    const runStream = "run:not-a-session";
    await db.transaction((tx) =>
      append(tx, workspace, [
        {
          streamId: runStream,
          events: [
            {
              type: "run.created",
              actor: "api",
              payload: { definition: {}, engineVersion: "test", brief: "", grants: [], budgets: {}, parent: null },
            },
          ],
        },
      ])
    );

    const all = await listStreams(db, workspace, { kind: "session", limit: 10 });
    expect(all.map((stream) => stream.streamId)).toEqual([second, first]);
    expect(all.some((stream) => stream.streamId === runStream)).toBe(false);

    // headSeq is the stream's head; updatedAt the head event's ts, ISO-parseable.
    const firstRow = all.find((stream) => stream.streamId === first);
    expect(firstRow?.headSeq).toBe(2);
    for (const stream of all) {
      expect(Number.isInteger(stream.headSeq)).toBe(true);
      expect(Number.isNaN(Date.parse(stream.updatedAt))).toBe(false);
    }
    // Newest first, also across the page boundary: `before` is the last
    // streamId of the previous page.
    const pageOne = await listStreams(db, workspace, { kind: "session", limit: 1 });
    expect(pageOne.map((stream) => stream.streamId)).toEqual([second]);
    const pageTwo = await listStreams(db, workspace, { kind: "session", limit: 10, before: second });
    expect(pageTwo.map((stream) => stream.streamId)).toEqual([first]);

    // Another workspace's streams never leak across.
    const other = await listStreams(db, "I1-other-workspace", { kind: "session", limit: 10 });
    expect(other).toEqual([]);
  });
});

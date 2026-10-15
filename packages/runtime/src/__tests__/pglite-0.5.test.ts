// ANY-96 R18 — PGlite 0.5 + @electric-sql/pglite-pgvector (RUNTIME §15.6).
//
// PG1/PG3: the vector extension is loadable through the store, on a data dir and
// in memory, so `create extension if not exists vector` works on PGlite as it
// does on the pgvector Postgres service. The extension is loaded by the adapter
// (PgliteAdapter); the runtime's migrations deliberately do not touch it.
//
// PG2: a data dir made by the 0.3 line keeps opening — the fixture tarball in
// fixtures/pglite-0.3/ was produced by 0.3.16 via
// fixtures/pglite-0.3/make-fixture.ts (the repo's own openStore + append, then
// PGlite#dumpDataDir); see that file's header for the exact command.
//
// PG4: the adapter contract R13 pinned on the new line — nested store
// transactions join as savepoints, top-level ones serialize on the one
// connection. Deadlock-prone cases race a 2 s deadline that fails as an
// assertion, never a test timeout (the R13 precedent).
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AssertionError } from "node:assert";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { openStore, type RuntimeStore } from "../index";
import { describeDrivers } from "../testing/drivers";

const untar = promisify(execFile);
const DEADLINE_MS = 2_000;

/** Settles like `promise`, or fails as an assertion when it hangs past the deadline. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AssertionError({
            message: `deadlocked: ${what} did not settle within ${DEADLINE_MS} ms`,
          })
        ),
      DEADLINE_MS
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * PG1's statements, verbatim on both drivers: enable the extension, a `vector(3)`
 * column, three rows, nearest-first under `<=>` from `[1,0,0]`. Cosine distances
 * from `[1,0,0]`: `one` 0, `two` 0.36, `three` 1 — the assertion is the order.
 */
async function vectorProbe(store: RuntimeStore): Promise<string[]> {
  return store.transaction(async (tx) => {
    await tx.query("create extension if not exists vector");
    await tx.query("create table r18_vec (id text primary key, embedding vector(3))");
    await tx.query(
      `insert into r18_vec (id, embedding) values
         ('one', '[1,0,0]'), ('two', '[0.6,0.8,0]'), ('three', '[0,1,0]')`
    );
    const rows = await tx.query("select id from r18_vec order by embedding <=> '[1,0,0]'");
    return rows.map((row) => String(row.id));
  });
}

describeDrivers("pgvector through the store (ANY-96 R18)", (h) => {
  test("PG1 create extension vector, a vector(3) column and <=> ordering work through openStore", async () => {
    const store = await h.openStore();
    expect(await within(vectorProbe(store), "the vector probe")).toEqual(["one", "two", "three"]);
  });
});

test("PG2 a data dir made by 0.3.16 opens through openStore; migrations are a no-op and its events read back", async () => {
  const fixtureTar = fileURLToPath(new URL("./fixtures/pglite-0.3/runtime-0.3.16.tar", import.meta.url));
  const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), "r18-fixture-"));
  try {
    await untar("tar", ["-xf", fixtureTar, "-C", dir]);
    const store = await openStore({ driver: "pglite", dataDir: dir });
    try {
      // No-op migrations: the fixture was made by this repo's own store code, so
      // opening it must leave every migration applied and none newly recorded.
      const applied = await store.transaction((tx) =>
        tx.query("select name from runtime_migrations order by name")
      );
      const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
      expect(applied.map((row) => String(row.name))).toEqual(files);

      const events = await store.readStream("run:fixture", { workspaceId: "ws-fixture" });
      expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
      expect(events.map((event) => event.type)).toEqual([
        "run.started",
        "run.started",
        "run.started",
      ]);
      expect(events.map((event) => event.payload)).toEqual([
        { objective: "fixture-one" },
        { objective: "fixture-two" },
        { objective: "fixture-three" },
      ]);
    } finally {
      await store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PG3 in-memory openStore (no data dir) has the vector extension available", async () => {
  const store = await openStore({ driver: "pglite" });
  try {
    expect(await within(vectorProbe(store), "the in-memory vector probe")).toEqual([
      "one",
      "two",
      "three",
    ]);
  } finally {
    await store.close();
  }
});

test("PG4a a nested store.transaction still joins the outer transaction as a savepoint", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "r18-nested-"));
  const store = await openStore({ driver: "pglite", dataDir: dir });
  try {
    await store.transaction((tx) => tx.query("create table r18_probe (id text primary key)"));
    const insert = "insert into r18_probe (id) values ($1)";

    await within(
      store.transaction(async (tx) => {
        await tx.query(insert, ["outer"]);
        // The nested call sees the outer's uncommitted insert: same transaction,
        // savepoint, not a queued second one.
        const rows = await within(
          store.transaction((nested) => nested.query("select id from r18_probe")),
          "the nested transaction"
        );
        expect(rows.map((row) => row.id)).toEqual(["outer"]);
      }),
      "the outer transaction"
    );
    const probe = await store.transaction((tx) => tx.query("select id from r18_probe"));
    expect(probe.map((row) => row.id)).toEqual(["outer"]);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("PG4b two concurrent top-level transactions still serialize on the one connection", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "r18-serial-"));
  const store = await openStore({ driver: "pglite", dataDir: dir });
  try {
    await store.transaction((tx) => tx.query("create table r18_probe (id text primary key)"));
    const insert = "insert into r18_probe (id) values ($1)";

    const settled = await within(
      Promise.allSettled([
        store.transaction(async (tx) => {
          await tx.query(insert, ["a1"]);
          await new Promise((resolve) => setTimeout(resolve, 10));
          await tx.query(insert, ["a2"]);
        }),
        store.transaction(async (tx) => {
          await tx.query(insert, ["b1"]);
          await new Promise((resolve) => setTimeout(resolve, 10));
          await tx.query(insert, ["b2"]);
        }),
      ]),
      "the two top-level transactions"
    );
    expect(settled.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

    const probe = await store.transaction((tx) => tx.query("select id from r18_probe order by id"));
    expect(probe.map((row) => row.id)).toEqual(["a1", "a2", "b1", "b2"]);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ANY-96 R18 — PGlite 0.5 + @electric-sql/pglite-pgvector (RUNTIME §15.6).
//
// PG1/PG3: the vector extension is loadable through the store, on a data dir and
// in memory, so `create extension if not exists vector` works on PGlite as it
// does on the pgvector Postgres service. The extension is loaded by the adapter
// (PgliteAdapter); the runtime's migrations deliberately do not touch it.
//
// PG2 (revised by Ty 2026-10-16): a data dir made by the 0.3 line holds
// Postgres 17 data, which the pinned PGlite (18.6) cannot open — no migration
// exists yet, so the store refuses it before constructing PGlite: the message
// names the dir, both majors and the delete-to-start-fresh way out, and the
// dir is left byte-identical. The fixture tarball in fixtures/pglite-0.3/ was
// produced by 0.3.16 via fixtures/pglite-0.3/make-fixture.ts (unchanged).
//
// PG2b: the expected-major constant in store/pglite.ts equals the major the
// pinned PGlite actually embeds, so a future pin bump that forgets to move
// the constant fails here.
//
// PG4: the adapter contract R13 pinned on the new line — nested store
// transactions join as savepoints, top-level ones serialize on the one
// connection. Deadlock-prone cases race a 2 s deadline that fails as an
// assertion, never a test timeout (the R13 precedent).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AssertionError } from "node:assert";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { openStore, type RuntimeStore } from "../index";
import { EXPECTED_PG_MAJOR } from "../store/pglite";
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

/** Every file under `dir` as `relative path → sha256`, the byte-identical check. */
async function fingerprint(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        files[path.relative(dir, child)] = createHash("sha256")
          .update(await readFile(child))
          .digest("hex");
      }
    }
  }
  await walk(dir);
  return files;
}

test("PG2 an old-major data dir (the 0.3.16 fixture, Postgres 17) is refused with a clear error and left byte-identical", async () => {
  const fixtureTar = fileURLToPath(new URL("./fixtures/pglite-0.3/runtime-0.3.16.tar", import.meta.url));
  // A digit-free prefix: the assertions below check the message contains
  // "17"/"18", which must come from the message body, not the tmp path.
  const dir = await mkdtemp(path.join(tmpdir(), "old-major-dir-"));
  try {
    await untar("tar", ["-xf", fixtureTar, "-C", dir]);
    const before = await fingerprint(dir);
    const failure = await openStore({ driver: "pglite", dataDir: dir }).then(
      () => undefined,
      (error: unknown) => error
    );
    // The store's clear refusal — not PGlite's raw `FATAL: database files
    // are incompatible with server`, and not a successful open: the dir
    // path, the found major (17), the expected major (18), the way out.
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain(dir);
    expect(message).toContain("17");
    expect(message).toContain("18");
    expect(message).toMatch(/delete/i);
    // Refused before PGlite was constructed: no file in the dir changed.
    expect(await fingerprint(dir)).toEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PG2b the expected-major constant equals the Postgres major the pinned PGlite embeds", async () => {
  const store = await openStore({ driver: "pglite" });
  try {
    const rows = await store.transaction((tx) =>
      tx.query("select current_setting('server_version_num') as version_num")
    );
    const versionNum = Number(rows[0]?.version_num);
    expect(Number.isInteger(versionNum)).toBe(true);
    // server_version_num 180006 → major 18; PG2 pins the refusal, this pins
    // the constant the refusal compares against.
    expect(Math.floor(versionNum / 10_000)).toBe(EXPECTED_PG_MAJOR);
  } finally {
    await store.close();
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

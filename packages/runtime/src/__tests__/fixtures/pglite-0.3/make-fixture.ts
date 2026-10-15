/**
 * Makes ./runtime-0.3.16.tar: a PGlite data dir holding the full runtime schema
 * (every migration in ../../migrations applied) and three `run.started` events on
 * stream `run:fixture` / workspace `ws-fixture`, dumped with PGlite's `dumpDataDir()`.
 *
 * It is the fixture behind test PG2 (ANY-96 R18): a data dir made by the 0.3 line
 * must keep opening through `openStore` after the 0.5 bump. The bytes must come
 * from the OLD line — run this at a commit where the workspace still resolves
 * `@electric-sql/pglite` 0.3.x (for this card: the red commit, base 9776480):
 *
 *   npm ci && npx tsx packages/runtime/src/__tests__/fixtures/pglite-0.3/make-fixture.ts
 *
 * and commit the refreshed tarball. The store code it runs is this repo's own
 * (`openStore` + `append`); nothing about the fixture is hand-made.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { append, openStore } from "../../../index";

export const FIXTURE_WORKSPACE = "ws-fixture";
export const FIXTURE_STREAM = "run:fixture";
/** The payloads PG2 asserts readStream returns, in seq order 1, 2, 3. */
export const FIXTURE_OBJECTIVES = ["fixture-one", "fixture-two", "fixture-three"];

const dataDir = await mkdtemp(path.join(tmpdir(), "pglite-0.3-fixture-"));
try {
  const store = await openStore({ driver: "pglite", dataDir });
  await store.transaction((tx) =>
    append(tx, FIXTURE_WORKSPACE, [
      {
        streamId: FIXTURE_STREAM,
        events: FIXTURE_OBJECTIVES.map((objective) => ({
          type: "run.started",
          actor: "fixture",
          payload: { objective },
        })),
      },
    ])
  );
  await store.close();

  // A fresh client on the closed dir: `dumpDataDir` lives on the PGlite class.
  const db = new PGlite(dataDir);
  const dump = await db.dumpDataDir();
  await db.close();
  // `dumpDataDir` types as File | Blob (DOM shapes); under Node it is a Blob —
  // take its bytes either way.
  const tar = Buffer.from(await dump.arrayBuffer());

  const out = fileURLToPath(new URL("./runtime-0.3.16.tar", import.meta.url));
  await writeFile(out, tar);
  console.log(`wrote ${out} (${tar.byteLength} bytes)`);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

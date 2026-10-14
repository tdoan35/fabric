// The crash harness (ANY-37 R11, RUNTIME §15.3): for every scenario, on every
// configured driver — PGlite always, Postgres when RUNTIME_TEST_DATABASE_URL
// is set — seed the scenario's streams and bootstrap jobs, boot worker 1 as
// its own OS process, wait for its barrier (the §15.3 kill point), SIGKILL it,
// boot worker 2 on the same data (same dataDir | same database), wait for the
// board to settle, then assert the §15.3 invariants:
//
//   every run finished; no two facts share a causation; the surface received
//   each message once; the fold of every stream equals the expected state.
//
// The KM variants flip one recovery switch each and assert the invariant
// BREAKS — the prove-it-can-fail form the card asks for, since the code under
// test already exists. Per driver and scenario, the run prints the time from
// the kill to the survivor's first claim (the handover), and exits non-zero
// if anything failed.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { fold } from "@fabric/core";
import { openStore, append } from "../src/index";
import type { RuntimeStore } from "../src/store/types";
import {
  appendWithoutCausationDedupe,
  isCausationDedupeQuery,
} from "../src/testing/crash-switches";
import { SCENARIOS, WORKSPACE, type Scenario } from "./scenarios";
import { readLog, sleep, waitForFile, type CrashLogEntry } from "./fakes";

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKER_ENTRY = path.join(PKG_DIR, "crash", "worker-entry.ts");

type DriverName = "pglite" | "postgres";
type DriverTarget = { kind: "pglite"; dataDir: string } | { kind: "postgres"; url: string };

const HANDOVER_TIMEOUT_MS = 20_000;
const SETTLE_WAIT_MS = 40_000;

/** stdout of the child, for failure diagnosis. */
function spawnWorker(cfg: unknown): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", WORKER_ENTRY, JSON.stringify(cfg)], {
    cwd: PKG_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function childStderr(child: ChildProcess): string {
  let out = "";
  if (child.stderr !== null) child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  return out;
}

async function waitForExit(child: ChildProcess, timeoutMs: number, what: string): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const { promise, resolve } = Promise.withResolvers<number | null>();
  const timer = setTimeout(() => resolve(null), timeoutMs);
  child.once("exit", (code) => {
    clearTimeout(timer);
    resolve(code ?? 0);
  });
  const code = await promise;
  if (code === null) child.kill("SIGKILL");
  if (code === null) throw new Error(`${what}: no exit within ${timeoutMs} ms`);
  return code;
}

/** deepStrictEqual with 1e-9 tolerance on numbers — the fold's costUsd sums
 * floats (0.1 + 0.2); the scenario's meaning is the number, not the ulp. */
function deepNear(actual: unknown, expected: unknown, path = "state"): void {
  if (typeof actual === "number" && typeof expected === "number") {
    if (Math.abs(actual - expected) > 1e-9) {
      throw new Error(`${path}: ${actual} !== ${expected}`);
    }
    return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      throw new Error(`${path}: length ${actual.length} !== ${expected.length}`);
    }
    actual.forEach((item, index) => deepNear(item, expected[index], `${path}[${index}]`));
    return;
  }
  if (typeof actual === "object" && actual !== null && typeof expected === "object" && expected !== null) {
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
    for (const key of keys) {
      if (!(key in a) || !(key in e)) {
        throw new Error(`${path}: key "${key}" on one side only`);
      }
      deepNear(a[key], e[key], `${path}.${key}`);
    }
    return;
  }
  if (actual !== expected) throw new Error(`${path}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

interface Row {
  driver: DriverName;
  scenario: string;
  handoverMs: number | null;
  settledMs: number | null;
  ok: boolean;
  failures: string[];
}

async function runScenario(driver: DriverName, target: DriverTarget, dir: string, scenario: Scenario): Promise<Row> {
  const logFile = path.join(dir, "log.jsonl");
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);

  const baseConfig = {
    driver: target,
    logFile,
    dir,
    model: scenario.model,
    tools: scenario.tools,
    surface: scenario.surface,
    switches: scenario.switches,
    settleTimeoutMs: scenario.settleTimeoutMs,
    leaseMs: 250,
  };

  // -- seed: streams + bootstrap jobs, through our own short-lived store ----
  const seedStore = await openStoreFor(target);
  try {
    await seedStore.transaction(async (tx) => {
      await append(tx, WORKSPACE, scenario.streams);
      let n = 0;
      for (const job of scenario.bootstrap) {
        await tx.query(
          `insert into jobs (id, type, key, stream_id, workspace_id, run_at, payload, status, attempts)
           values ($1, $2, $3, $4, $5, 0, null, 'pending', 0)`,
          [`crash-job-${n++}`, job.type, job.key, job.streamId, WORKSPACE]
        );
      }
    });
  } finally {
    await seedStore.close();
  }

  // -- worker 1: run to the kill point, then SIGKILL -------------------------
  const killBarrier = scenario.kill.barrier;
  const killAfterKey = "afterCompleteOfKey" in scenario.kill ? scenario.kill.afterCompleteOfKey : undefined;
  const w1 = spawnWorker({
    ...baseConfig,
    workerId: "w1",
    ...(killAfterKey !== undefined ? { blockClaimAfterCompleteOf: { key: killAfterKey, barrier: killBarrier } } : {}),
  });
  const w1Err = childStderr(w1);
  const reached = await waitForFile(path.join(dir, `barrier-${killBarrier}`), HANDOVER_TIMEOUT_MS);
  if (!reached) {
    fail(`worker 1 never reached the ${scenario.id} kill point (${killBarrier})`);
    w1.kill("SIGKILL");
    await waitForExit(w1, 5_000, "w1");
    return { driver, scenario: scenario.id, handoverMs: null, settledMs: null, ok: false, failures };
  }
  const tKill = Date.now();
  w1.kill("SIGKILL");
  await waitForExit(w1, 5_000, "worker 1 after SIGKILL");
  if (w1Err.trim() !== "" && !scenario.expectNoSettle) {
    // stderr before the kill is harness-relevant only when it is not the
    // expected KM noise; report it for diagnosis.
    fail(`worker 1 stderr: ${w1Err.trim().slice(0, 400)}`);
  }

  // -- worker 2: the survivor on the same data --------------------------------
  const tSurvivor = Date.now();
  const w2 = spawnWorker({ ...baseConfig, workerId: "w2" });
  const w2Err = childStderr(w2);
  const w2Code = await waitForExit(w2, SETTLE_WAIT_MS, "worker 2");
  const settledMs = Date.now() - tSurvivor;

  const log = readLog(logFile);
  const firstSurvivorClaim = log.find(
    (line) => line.ev === "claim" && line.worker === "w2" && line.t >= tKill
  );
  const handoverMs = firstSurvivorClaim !== undefined ? firstSurvivorClaim.t - tKill : null;

  if (scenario.expectNoSettle) {
    // KM1: with lease expiry off, the killed job is never reclaimed — the
    // run must NOT have finished once the survivor gives up, and no reclaim
    // may appear in the claim log. (The survivor exits 0 on fact-head
    // stability: a board it cannot claim looks quiet — the missing
    // run.finished is the evidence, not its exit code.)
    const store = await openStoreFor(target);
    try {
      const finished = await countFacts(store, scenario.streams[0]!.streamId, "run.finished");
      if (finished !== 0) fail(`KM1: the run finished (${finished} run.finished facts) with lease expiry off`);
      const reclaims = log.filter((line) => line.ev === "claim" && line.worker === "w2" && line.attempt > 1);
      if (reclaims.length !== 0) fail("KM1: worker 2 reclaimed a dead lease although expiry is off");
    } finally {
      await store.close();
    }
    return {
      driver,
      scenario: scenario.id,
      handoverMs: null,
      settledMs: null,
      ok: failures.length === 0,
      failures,
    };
  }

  if (w2Code !== 0) fail(`worker 2 exited ${w2Code}: ${w2Err.trim().slice(0, 400)}`);

  // -- the §15.3 invariants ----------------------------------------------------
  const store = await openStoreFor(target);
  try {
    const duplicates = await store.transaction(async (tx) => {
      const rows = await tx.query(
        `select stream_id, causation from events
         where class = 'fact' and causation is not null and workspace_id = $1
         group by stream_id, causation having count(*) > 1`,
        [WORKSPACE]
      );
      return rows as { stream_id: string; causation: string }[];
    });
    if (duplicates.length > 0) {
      fail(`duplicate facts: ${duplicates.map((row) => `${row.stream_id} ${row.causation}`).join(", ")}`);
    }

    for (const expected of scenario.expect.finished ?? []) {
      const facts = await factsOf(store, expected.stream);
      const finished = facts.filter((event) => event.type === "run.finished");
      if (finished.length !== 1) {
        fail(`${expected.stream}: ${finished.length} run.finished facts, expected 1`);
        continue;
      }
      const payload = finished[0]!.payload as { result?: unknown; costUsd?: unknown };
      try {
        deepNear(payload.result, expected.result, `${expected.stream}: run.finished.result`);
        deepNear(payload.costUsd, expected.costUsd, `${expected.stream}: run.finished.costUsd`);
      } catch (error) {
        fail(`${expected.stream}: run.finished ${JSON.stringify(payload)} — ${(error as Error).message}`);
      }
    }

    for (const expected of scenario.expect.fold ?? []) {
      const events = await store.readStream(expected.stream, { workspaceId: WORKSPACE });
      const state = fold(events);
      const projection = {
        status: state.status,
        turn: state.turn,
        calls: state.calls,
        costUsd: state.costUsd,
        ...(state.turnCostUsd !== undefined ? { turnCostUsd: state.turnCostUsd } : {}),
        pendingInputs: state.pendingInputs,
        delegations: state.delegations,
        openToolCalls: state.openToolCalls.size,
        ...("lastFact" in expected.state
          ? state.lastFact !== null
            ? { lastFact: { type: state.lastFact.type, payload: state.lastFact.payload } }
            : { lastFact: null }
          : {}),
      };
      try {
        deepNear(projection, expected.state);
      } catch (error) {
        fail(`${expected.stream}: fold mismatch — ${(error as Error).message.slice(0, 500)}`);
      }
    }

    for (const expected of scenario.expect.receipts ?? []) {
      const receipts = log.filter(
        (line) =>
          line.ev === "surface-send" &&
          line.target === expected.target &&
          line.resolved &&
          line.deduped !== true
      ).length;
      if (receipts !== expected.count) {
        fail(`surface ${expected.target}: ${receipts} receipts, expected ${expected.count}`);
      }
    }

    for (const expected of scenario.expect.interrupted ?? []) {
      const count = await countFacts(store, expected.stream, "tool.interrupted");
      const present = count > 0;
      if (present !== expected.present) {
        fail(`${expected.stream}: tool.interrupted present=${present}, expected ${expected.present}`);
      }
    }

    for (const expected of scenario.expect.toolRuns ?? []) {
      const runs = log.filter(
        (line) => line.ev === "tool-run" && line.tool === expected.tool && line.resolved
      ).length;
      if (runs !== expected.count) {
        fail(`tool ${expected.tool}: ${runs} resolved runs, expected ${expected.count}`);
      }
    }

    for (const expected of scenario.expect.modelNote ?? []) {
      const resolved = log.filter(
        (line) => line.ev === "model-call" && line.system === expected.system && line.resolved
      );
      const call = resolved[expected.call] as { note?: string } | undefined;
      if (call === undefined || !String(call.note ?? "").includes(expected.contains)) {
        fail(`${expected.system} call #${expected.call}: note ${JSON.stringify(call?.note)} lacks "${expected.contains}"`);
      }
    }

    // -- KM2's append-level proof: the switch named "append without it" --------
    if (scenario.km2AfterSettle) {
      await km2Proof(store, fail);
    }
  } finally {
    await store.close();
  }

  return { driver, scenario: scenario.id, handoverMs, settledMs, ok: failures.length === 0, failures };
}

/**
 * KM2: with the causation dedupe switched off (the index already dropped by
 * the children, the pre-check blinded by the store wrapper), the append a
 * re-delivered job would issue — the identical fact, same causation — records
 * a SECOND row. The control run first proves the same append through the
 * plain store is the recorded no-op the pre-check makes it.
 */
async function km2Proof(store: RuntimeStore, fail: (message: string) => void): Promise<void> {
  const stream = "run:k3";
  const events = await store.readStream(stream, { workspaceId: WORKSPACE });
  const completed = events.find((event) => event.type === "llm.completed" && event.causation !== null);
  if (completed === undefined) {
    fail("KM2: no llm.completed fact to re-deliver");
    return;
  }
  const reDelivered = {
    type: completed.type,
    actor: completed.actor,
    payload: completed.payload,
    causation: completed.causation,
  };
  const countBefore = await countCausation(store, stream, completed.causation!);

  // Control: through the honest store, the re-delivered append is a no-op.
  const control = await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId: stream, events: [reDelivered] }]));
  if (control[0]!.duplicate !== true) {
    fail("KM2 control: the plain re-append was not recognised as a duplicate");
  }
  if ((await countCausation(store, stream, completed.causation!)) !== countBefore) {
    fail("KM2 control: the plain re-append recorded a row");
  }

  // Switched: append without causation dedupe records the duplicate fact.
  const blind = appendWithoutCausationDedupe(store);
  const sawDedupeQuery = { value: false };
  const instrumented: RuntimeStore = {
    transaction: (fn) =>
      blind.transaction((tx) =>
        fn({
          query: async (sql, params) => {
            if (isCausationDedupeQuery(sql)) sawDedupeQuery.value = true;
            return tx.query(sql, params);
          },
          onCommit: tx.onCommit,
        })
      ),
    readStream: (streamId, options) => blind.readStream(streamId, options),
    close: () => blind.close(),
  };
  await instrumented.transaction((tx) => append(tx, WORKSPACE, [{ streamId: stream, events: [reDelivered] }]));
  if (!sawDedupeQuery.value) {
    fail("KM2: the wrapper never saw append's dedupe query — store.append's shape changed; update the switch");
  }
  const countAfter = await countCausation(store, stream, completed.causation!);
  if (countAfter !== countBefore + 1) {
    fail(`KM2: the dedupe-blind append recorded ${countAfter - countBefore} rows, expected the duplicate (+1)`);
  }
}

async function countCausation(store: RuntimeStore, streamId: string, causation: string): Promise<number> {
  return store.transaction(async (tx) => {
    const rows = await tx.query(
      `select count(*)::int as c from events
       where stream_id = $1 and workspace_id = $2 and causation = $3 and class = 'fact'`,
      [streamId, WORKSPACE, causation]
    );
    return Number(rows[0]?.c ?? 0);
  });
}

async function factsOf(store: RuntimeStore, streamId: string) {
  return (await store.readStream(streamId, { workspaceId: WORKSPACE })).filter((event) => event.class === "fact");
}

async function countFacts(store: RuntimeStore, streamId: string, type: string): Promise<number> {
  return (await factsOf(store, streamId)).filter((event) => event.type === type).length;
}

/** A short-lived harness store: for PGlite, only ever while no child lives. */
async function openStoreFor(target: DriverTarget): Promise<RuntimeStore> {
  return target.kind === "pglite"
    ? openStore({ driver: "pglite", dataDir: target.dataDir })
    : openStore({ driver: "postgres", url: target.url });
}

// -- drivers ---------------------------------------------------------------------

interface PgDatabase {
  url: string;
  drop: () => Promise<void>;
}

async function freshPostgres(adminUrl: string): Promise<PgDatabase> {
  const admin = new Pool({ connectionString: adminUrl });
  const name = `fabric_crash_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const dropper = new Pool({ connectionString: adminUrl });
      try {
        await dropper.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await dropper.end();
      }
    },
  };
}

async function main(): Promise<void> {
  const drivers: DriverName[] = ["pglite"];
  const pgUrl = process.env.RUNTIME_TEST_DATABASE_URL;
  if (pgUrl !== undefined && pgUrl !== "") drivers.push("postgres");

  const rows: Row[] = [];
  for (const scenario of SCENARIOS) {
    for (const driver of drivers) {
      const dir = mkdtempSync(path.join(tmpdir(), `crash-${scenario.id}-${driver}-`));
      let database: PgDatabase | null = null;
      try {
        const target: DriverTarget =
          driver === "pglite"
            ? { kind: "pglite", dataDir: path.join(dir, "db") }
            : ((database = await freshPostgres(pgUrl!)), { kind: "postgres", url: database.url });
        const row = await runScenario(driver, target, dir, scenario);
        rows.push(row);
        const mark = row.ok ? "ok " : "FAIL";
        const handover = row.handoverMs === null ? "-" : `${row.handoverMs} ms`;
        console.log(`${mark}  ${driver.padEnd(8)} ${scenario.id.padEnd(4)} handover ${handover.padStart(8)}`);
        for (const failure of row.failures) console.log(`       - ${failure}`);
      } finally {
        if (database !== null) await database.drop().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  // The §15.3 deliverable: per driver and scenario, kill → the survivor's
  // first claim of the dead worker's job.
  console.log("\nHandover (kill → survivor's first claim):");
  const byDriver = new Map<DriverName, Row[]>();
  for (const row of rows) {
    const list = byDriver.get(row.driver) ?? [];
    list.push(row);
    byDriver.set(row.driver, list);
  }
  for (const [driver, list] of byDriver) {
    const cells = list.map((row) => `${row.scenario}=${row.handoverMs === null ? ">window" : `${row.handoverMs}ms`}`);
    console.log(`  ${driver.padEnd(8)} ${cells.join("  ")}`);
  }

  const failed = rows.filter((row) => !row.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} run(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${rows.length} run(s) passed`);
}

void main().catch((error) => {
  console.error("crash suite failed:", error);
  process.exit(1);
});

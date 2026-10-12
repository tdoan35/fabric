// Test drivers for the runtime suite (ANY-31 R5). Every case runs on PGlite, and on
// Postgres when RUNTIME_TEST_DATABASE_URL is set. In CI the Postgres leg is mandatory:
// the guard below throws at collection time, so a silently skipped Postgres suite can
// never pass. Each test gets a fresh database (Postgres) or data dir (PGlite).
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, afterEach } from "vitest";
import { Pool } from "pg";
import { openStore, type RuntimeStore } from "../index";

/** The two storage drivers the store must behave identically on. */
export type TestDriver = "pglite" | "postgres";

/** Handed to the suite once per driver; every store it opens shares one fresh database. */
export interface DriverHarness {
  driver: TestDriver;
  /** A store on a backend that is empty for the current test. */
  openStore(): Promise<RuntimeStore>;
}

type DriverSpec = { driver: "pglite" } | { driver: "postgres"; url: string };

/**
 * The guard R5.13 tests directly: the Postgres URL when configured, undefined when the
 * leg is legitimately absent (no CI), and a thrown error naming RUNTIME_TEST_DATABASE_URL
 * when CI=true would otherwise drop the Postgres leg silently.
 */
export function postgresUrlFromEnv(): string | undefined {
  const url = process.env.RUNTIME_TEST_DATABASE_URL;
  if (url === undefined || url === "") {
    if (process.env.CI) {
      throw new Error(
        "RUNTIME_TEST_DATABASE_URL is not set: with CI=true the Postgres driver leg is mandatory (packages/runtime/src/testing/drivers.ts)"
      );
    }
    return undefined;
  }
  return url;
}

/** Runs `fn` once per configured driver, under a describe tagged with the driver name. */
export function describeDrivers(name: string, fn: (h: DriverHarness) => void): void {
  const postgresUrl = postgresUrlFromEnv();
  const drivers: DriverSpec[] = [{ driver: "pglite" }];
  if (postgresUrl !== undefined) drivers.push({ driver: "postgres", url: postgresUrl });

  for (const spec of drivers) {
    describe(`${name} [${spec.driver}]`, () => {
      const state: {
        store?: Promise<RuntimeStore>;
        dispose?: () => Promise<void>;
      } = {};

        afterEach(async () => {
          state.store = undefined;
          if (state.dispose !== undefined) {
            const dispose = state.dispose;
            state.dispose = undefined;
            await dispose();
          }
        });

      const harness: DriverHarness = {
        driver: spec.driver,
        openStore(): Promise<RuntimeStore> {
          // One backend per test: the first call creates it, later calls reuse it.
          state.store ??= openStoreFor(spec).then((opened) => {
            state.dispose = opened.dispose;
            return opened.store;
          });
          return state.store;
        },
      };

      fn(harness);
    });
  }
}

async function openStoreFor(
  spec: DriverSpec
): Promise<{ store: RuntimeStore; dispose: () => Promise<void> }> {
  if (spec.driver === "pglite") {
    const dir = await mkdtemp(path.join(tmpdir(), "runtime-pglite-"));
    try {
      const store = await openStore({ driver: "pglite", dataDir: dir });
      return {
        store,
        dispose: async () => {
          await store.close();
          await rm(dir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  // Fresh database per test, via the admin database of the same server. Trust auth is
  // part of the R0/R5 contract: no password ever enters the repo or the environment.
  const admin = new Pool({ connectionString: adminUrl(spec.url) });
  // Same contract as the store pool: a pool with no 'error' listener turns any late
  // idle-client death (pool end racing the server, drop of the test database) into an
  // uncaught exception after the suite has already gone green.
  admin.on("error", () => undefined);
  const database = `runtime_test_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  try {
    await admin.query(`create database "${database}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  try {
    const store = await openStore({ driver: "postgres", url: withDatabase(spec.url, database) });
    return {
      store,
      dispose: async () => {
        await store.close();
        await admin.query(`drop database if exists "${database}" with (force)`);
        await admin.end();
      },
    };
  } catch (error) {
    await admin.query(`drop database if exists "${database}" with (force)`);
    await admin.end();
    throw error;
  }
}

/** The same server, admin database: where `create database` runs. */
function adminUrl(url: string): string {
  return withDatabase(url, "postgres");
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

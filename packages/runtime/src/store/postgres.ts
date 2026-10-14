// Postgres: the server driver. Every top-level transaction gets its own pooled
// connection, so concurrent appends interleave and the head lock serializes just
// the sequence. One opened inside another's callback joins it as a savepoint on
// the same connection (R13), seeing its uncommitted writes.
import { Pool, type PoolClient } from "pg";
import type { Adapter } from "./adapter";
import { TransactionNesting } from "./nesting";
import type { Row, RuntimeTx } from "./types";

export class PostgresAdapter implements Adapter {
  private readonly pool: Pool;
  private readonly nesting = new TransactionNesting();

  constructor(url: string) {
    this.pool = new Pool({ connectionString: url });
    // Errors on idle pool clients (a dropped connection, the test harness's
    // `drop database ... with (force)` racing pool.end(), which resolves before the
    // sockets close) surface as pool "error" events. pg-pool rethrows those as
    // uncaught exceptions when no listener is attached, killing the process after
    // the work is already done — so always attach one.
    this.pool.on("error", () => undefined);
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    const result = await this.pool.query(sql, params as unknown[]);
    return result.rows as Row[];
  }

  async transaction<T>(run: (tx: RuntimeTx) => Promise<T>): Promise<T> {
    const nested = this.nesting.join(run);
    if (nested !== undefined) return nested;
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("begin");
      const hooks: Array<() => unknown> = [];
      const query = async (sql: string, params?: readonly unknown[]): Promise<Row[]> => {
        const result = await client.query(sql, (params ?? []) as unknown[]);
        return result.rows as Row[];
      };
      let value: T;
      try {
        value = await this.nesting.top(query, hooks, run);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
      // After commit, before the connection goes back to the pool.
      for (const hook of hooks) await hook();
      return value;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

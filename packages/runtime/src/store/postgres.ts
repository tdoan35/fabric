// Postgres: the server driver. Every transaction gets its own pooled connection, so
// concurrent appends interleave and the head lock serializes just the sequence.
import { Pool, type PoolClient } from "pg";
import type { Adapter } from "./adapter";
import type { Row, RuntimeTx } from "./types";

export class PostgresAdapter implements Adapter {
  private readonly pool: Pool;

  constructor(url: string) {
    this.pool = new Pool({ connectionString: url });
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    const result = await this.pool.query(sql, params as unknown[]);
    return result.rows as Row[];
  }

  async transaction<T>(run: (tx: RuntimeTx) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("begin");
      const hooks: Array<() => unknown> = [];
      const tx: RuntimeTx = {
        query: async (sql, params) => {
          const result = await client.query(sql, (params ?? []) as unknown[]);
          return result.rows as Row[];
        },
        onCommit: (hook) => hooks.push(hook),
      };
      let value: T;
      try {
        value = await run(tx);
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

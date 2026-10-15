// PGlite: the embedded Postgres inside the desktop app. One connection, so
// top-level transactions are serialized through a promise chain; one opened
// inside another's callback joins it as a savepoint (R13) rather than queueing
// behind it, which would deadlock.
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { Adapter } from "./adapter";
import { TransactionNesting } from "./nesting";
import type { Row, RuntimeTx } from "./types";

export class PgliteAdapter implements Adapter {
  private readonly db: PGlite;
  /** The tail of the transaction chain; keeps a failed transaction from breaking the next. */
  private tail: Promise<unknown> = Promise.resolve();
  private readonly nesting = new TransactionNesting();

  constructor(dataDir?: string) {
    // RUNTIME §15.6: pgvector is available wherever the store is — data dir or
    // in-memory. PGlite only wires extensions at construction, so both shapes
    // pass the same set; `create extension if not exists vector` then works
    // through the store as it does on the pgvector Postgres service. The
    // runtime's migrations stay extension-free (the memory work owns those).
    const options = { extensions: { vector } };
    this.db = dataDir === undefined ? new PGlite(options) : new PGlite(dataDir, options);
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    const result = await this.db.query(sql, params as unknown[]);
    return result.rows as Row[];
  }

  async transaction<T>(run: (tx: RuntimeTx) => Promise<T>): Promise<T> {
    const nested = this.nesting.join(run);
    if (nested !== undefined) return nested;
    const result = this.tail.then(() => this.runTransaction(run));
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async runTransaction<T>(run: (tx: RuntimeTx) => Promise<T>): Promise<T> {
    const hooks: Array<() => unknown> = [];
    let value: T;
    try {
      await this.query("begin");
      value = await this.nesting.top((sql, params) => this.query(sql, params), hooks, run);
      await this.query("commit");
    } catch (error) {
      await this.query("rollback").catch(() => undefined);
      throw error;
    }
    for (const hook of hooks) await hook();
    return value;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

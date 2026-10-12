// PGlite: the embedded Postgres inside the desktop app. One connection, so
// transactions are serialized through a promise chain.
import { PGlite } from "@electric-sql/pglite";
import type { Adapter } from "./adapter";
import type { Row, RuntimeTx } from "./types";

export class PgliteAdapter implements Adapter {
  private readonly db: PGlite;
  /** The tail of the transaction chain; keeps a failed transaction from breaking the next. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(dataDir?: string) {
    this.db = dataDir === undefined ? new PGlite() : new PGlite(dataDir);
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    const result = await this.db.query(sql, params as unknown[]);
    return result.rows as Row[];
  }

  async transaction<T>(run: (tx: RuntimeTx) => Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.runTransaction(run));
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async runTransaction<T>(run: (tx: RuntimeTx) => Promise<T>): Promise<T> {
    const hooks: Array<() => unknown> = [];
    const tx: RuntimeTx = {
      query: (sql, params) => this.query(sql, params),
      onCommit: (hook) => hooks.push(hook),
    };
    let value: T;
    try {
      await this.query("begin");
      value = await run(tx);
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

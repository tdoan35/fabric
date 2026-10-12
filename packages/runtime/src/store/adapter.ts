// The driver seam: one tiny interface, two backends, identical SQL above it.
import type { Row, RuntimeTx } from "./types";

export interface Adapter {
  /** Multi-statement script, used by the migration runner. */
  exec(sql: string): Promise<void>;
  query(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  transaction<T>(run: (tx: RuntimeTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

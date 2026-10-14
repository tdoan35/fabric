// Nested transactions (ANY-79 R13): a store transaction opened while another
// one's callback is running, in its async context, joins it as a savepoint on
// the same connection instead of taking a second one. On PGlite a second
// transaction would queue behind the first and deadlock; on Postgres it would
// run on another connection, blind to the outer's uncommitted writes. Both
// adapters share this, so the rule is identical on both drivers.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Row, RuntimeTx } from "./types";

type Query = (sql: string, params?: readonly unknown[]) => Promise<Row[]>;

/** One transaction level: the top-level transaction or a savepoint inside it. */
interface Frame {
  readonly query: Query;
  /** This level's onCommit hooks; a savepoint hands its own up on release. */
  readonly hooks: Array<() => unknown>;
  readonly parent: Frame | undefined;
  /** Shared by every frame of one top-level transaction: unique savepoint names. */
  readonly counter: { next: number };
  /** Serialises this level's nested transactions, so savepoints never interleave. */
  chain: Promise<unknown>;
  /** Set once this level's callback has settled; later work no longer joins it. */
  settled: boolean;
}

export class TransactionNesting {
  private readonly context = new AsyncLocalStorage<Frame>();

  /** The innermost transaction level whose callback is still running here, if any. */
  private active(): Frame | undefined {
    let frame = this.context.getStore();
    while (frame !== undefined && frame.settled) frame = frame.parent;
    return frame;
  }

  /**
   * Runs `run` as a savepoint of the active transaction, or returns undefined
   * when there is none and the caller must start a top-level transaction.
   */
  join<T>(run: (tx: RuntimeTx) => Promise<T>): Promise<T> | undefined {
    const parent = this.active();
    if (parent === undefined) return undefined;
    const result = parent.chain.then(() => this.savepoint(parent, run));
    parent.chain = result.catch(() => undefined);
    return result;
  }

  /**
   * Runs a top-level transaction's callback as the active level for its async
   * context. `hooks` is the list the adapter runs after its commit.
   */
  async top<T>(query: Query, hooks: Array<() => unknown>, run: (tx: RuntimeTx) => Promise<T>): Promise<T> {
    const frame: Frame = {
      query,
      hooks,
      parent: undefined,
      counter: { next: 0 },
      chain: Promise.resolve(),
      settled: false,
    };
    try {
      return await this.context.run(frame, () => run(txOf(frame)));
    } finally {
      frame.settled = true;
    }
  }

  private async savepoint<T>(parent: Frame, run: (tx: RuntimeTx) => Promise<T>): Promise<T> {
    parent.counter.next += 1;
    const name = `fabric_sp_${parent.counter.next}`;
    const frame: Frame = {
      query: parent.query,
      hooks: [],
      parent,
      counter: parent.counter,
      chain: Promise.resolve(),
      settled: false,
    };
    await parent.query(`savepoint ${name}`);
    let value: T;
    try {
      value = await this.context.run(frame, () => run(txOf(frame)));
    } catch (error) {
      frame.settled = true;
      await parent.query(`rollback to savepoint ${name}`).catch(() => undefined);
      await parent.query(`release savepoint ${name}`).catch(() => undefined);
      throw error;
    }
    frame.settled = true;
    await parent.query(`release savepoint ${name}`);
    // Released: its hooks now wait on the parent, and run after the outermost commit.
    parent.hooks.push(...frame.hooks);
    return value;
  }
}

function txOf(frame: Frame): RuntimeTx {
  return { query: frame.query, onCommit: (hook) => frame.hooks.push(hook) };
}

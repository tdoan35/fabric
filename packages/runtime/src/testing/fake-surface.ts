// The fake surface: the SurfacePort test double for the worker suites (ANY-40
// R9c). Records every send with the exact target, text and idempotency key the
// worker passed, and plays a scripted failure list — one entry per attempt, so
// a delivery that must fail twice before succeeding is two errors and then
// silence. Receipts are sequential `pm-<n>`, the successful sends counted.
//
// Deliberately self-typed (no import of ../ports), like fake-model: it
// satisfies the port structurally.

/** One send attempt, successful or not, as the handler issued it. */
export interface FakeSurfaceSend {
  target: string;
  text: string;
  idempotencyKey?: string;
}

export class FakeSurface {
  /** Every attempt in issue order, failures included. */
  readonly attempts: FakeSurfaceSend[] = [];

  private readonly sentLog: FakeSurfaceSend[] = [];

  private readonly failures: Error[];

  constructor(failures: readonly Error[] = []) {
    this.failures = [...failures];
  }

  /** The sends that returned a receipt, in order. */
  get sent(): readonly FakeSurfaceSend[] {
    return this.sentLog;
  }

  /** The port's `send`: pop the next scripted failure; with none left, succeed. */
  async send(
    target: string,
    message: { text: string; subject?: string },
    options?: { idempotencyKey?: string }
  ): Promise<{ platformMessageId: string }> {
    const record: FakeSurfaceSend = {
      target,
      text: message.text,
      ...(options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    };
    this.attempts.push(record);
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    this.sentLog.push(record);
    return { platformMessageId: `pm-${this.sentLog.length}` };
  }
}

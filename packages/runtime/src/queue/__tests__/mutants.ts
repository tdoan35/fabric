// Three deliberately broken MemoryQueue variants (ANY-32 R6). Each breaks
// exactly one property of the reference implementation; the conformance suite
// must fail against each (QM1-QM3) — the proof that the suite can fail.
import { MemoryQueue } from "../memory";
import type { QueueJob } from "../types";

/** QM1: no per-stream serialisation — two decide runs per stream at once. */
export class UnserialisedStreamsQueue extends MemoryQueue {
  protected override hasParallelSerialLease(_job: QueueJob): boolean {
    return false;
  }
}

/** QM2: leases never expire — a lost worker's jobs are stuck forever. */
export class NeverExpiringLeasesQueue extends MemoryQueue {
  protected override leaseExpired(_expiresAt: number | null, _now: number): boolean {
    return false;
  }
}

/** QM3: the idempotency key is ignored on enqueue — duplicates land freely. */
export class KeylessEnqueueQueue extends MemoryQueue {
  protected override liveWithKey(_key: string): QueueJob | undefined {
    return undefined;
  }
}

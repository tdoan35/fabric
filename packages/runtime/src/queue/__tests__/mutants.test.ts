// QM1-QM3: each broken variant must fail its target conformance case —
// the proof that the suite can fail (ANY-32 R6).
import { expect, test } from "vitest";
import { queueConformanceCases } from "../conformance";
import { KeylessEnqueueQueue, NeverExpiringLeasesQueue, UnserialisedStreamsQueue } from "./mutants";

const caseById = new Map(queueConformanceCases.map((testCase) => [testCase.id, testCase]));

test("QM1 a queue with no per-stream serialisation fails Q3", async () => {
  await expect(caseById.get("Q3")!.run(() => new UnserialisedStreamsQueue())).rejects.toThrow();
});

test("QM2 a queue whose leases never expire fails Q5", async () => {
  await expect(caseById.get("Q5")!.run(() => new NeverExpiringLeasesQueue())).rejects.toThrow();
});

test("QM3 a queue that ignores the idempotency key on enqueue fails Q1", async () => {
  await expect(caseById.get("Q1")!.run(() => new KeylessEnqueueQueue())).rejects.toThrow();
});

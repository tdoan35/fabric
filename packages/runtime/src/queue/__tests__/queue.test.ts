// The conformance suite, run by the reference implementation (ANY-32 R6).
import { runQueueConformance } from "../conformance";
import { MemoryQueue } from "../memory";

runQueueConformance("MemoryQueue", (options) => new MemoryQueue(options));

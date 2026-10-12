// @fabric/core — the runtime's pure data layer (RUNTIME §2–§3, §10): the event envelope,
// per-type payload schemas and classes, upcasters, and stream ids. No I/O of any kind.
export { EVENT_PAYLOAD_SCHEMAS, EVENT_CLASSES, isFact, eventClass } from "./events/schemas";
export type { EventClass, EventType } from "./events/schemas";
export { EventParseError, parseEvent } from "./events/parse";
export type { TypedEvent } from "./events/parse";
export { registerEventType, latestVersion } from "./events/registry";
export type { Upcaster, EventTypeRegistration } from "./events/registry";
export { streamId, parseStreamId, STREAM_PREFIXES } from "./streams";
export type { StreamKind, ParsedStreamId } from "./streams";
export { fold, FoldError } from "./fold/fold";
export type {
  AgentState,
  FoldInit,
  LastFact,
  PendingInput,
  ToolCall,
  Wait,
  Definition,
} from "./fold/fold";
export { decideAgent } from "./decide/decide";
export type { DecideDef, DecideEvent, DecideJob, Decision } from "./decide/decide";

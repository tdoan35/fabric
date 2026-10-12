// parseEvent: the only door into the log's data. Validates the envelope (RUNTIME §2),
// upcasts old payload versions in order (§10), and strict-checks the payload against the
// type's latest schema (§3). Never mutates its input.
import { z } from "zod";
import { entryFor } from "./registry";
import type { EventClass } from "./schemas";
import { parseStreamId } from "../streams";

/** The envelope fields every event carries, plus its typed payload (RUNTIME §2). */
export type TypedEvent = {
  [K in keyof typeof import("./schemas").EVENT_PAYLOAD_SCHEMAS]: {
    id: string;
    workspaceId: string;
    streamId: string;
    seq: number;
    type: K;
    class: EventClass;
    /** The (upcasted) payload version the parsed event carries. */
    v: number;
    actor: string;
    /** The job key that produced the event, or null for API appends. */
    causation: string | null;
    ts: string;
    payload: z.output<(typeof import("./schemas").EVENT_PAYLOAD_SCHEMAS)[K]>;
  };
}[keyof typeof import("./schemas").EVENT_PAYLOAD_SCHEMAS];

/** Raised for every malformed event; the message names the offending field or type. */
export class EventParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventParseError";
  }
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new EventParseError(`event ${field} must be a non-empty string`);
  }
  return value;
}

export function parseEvent(raw: unknown): TypedEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new EventParseError("event must be a JSON object");
  }
  const record = raw as Record<string, unknown>;

  const type = typeof record.type === "string" ? record.type : undefined;
  const entry = type !== undefined ? entryFor(type) : undefined;
  if (entry === undefined || type === undefined) {
    throw new EventParseError(`unknown event type: ${String(record.type)}`);
  }

  const v = record.v === undefined ? 1 : record.v;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new EventParseError(`event v must be a positive integer, got ${String(record.v)}`);
  }
  if (v > entry.latest) {
    throw new EventParseError(
      `event type "${type}" v${v} is newer than the latest known version v${entry.latest}`
    );
  }

  // Upcast in order, one version at a time, then validate the latest shape.
  let payload = record.payload;
  let version = v;
  while (version < entry.latest) {
    const upcast = entry.upcasters.get(version);
    if (upcast === undefined) {
      throw new EventParseError(`missing upcaster for "${type}" v${version}`);
    }
    payload = upcast(payload);
    version += 1;
  }

  const id = requireString(record, "id");
  const workspaceId = requireString(record, "workspaceId");
  const streamIdValue = requireString(record, "streamId");
  try {
    parseStreamId(streamIdValue);
  } catch (error) {
    throw new EventParseError((error as Error).message);
  }
  const seq = record.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw new EventParseError(`event seq must be a positive integer, got ${String(record.seq)}`);
  }
  const actor = requireString(record, "actor");
  const causation = record.causation;
  if (causation !== null && typeof causation !== "string") {
    throw new EventParseError("event causation must be a string or null");
  }
  const ts = requireString(record, "ts");
  const declaredClass = record.class === undefined ? entry.eventClass : record.class;
  if (declaredClass !== entry.eventClass) {
    throw new EventParseError(
      `event class ${JSON.stringify(String(record.class))} does not match "${type}" (${entry.eventClass})`
    );
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = entry.schema.parse(payload);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const detail = error.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
          return `payload.${path}: ${issue.message}`;
        })
        .join("; ");
      throw new EventParseError(`invalid "${type}" payload: ${detail}`);
    }
    throw error;
  }

  return {
    id,
    workspaceId,
    streamId: streamIdValue,
    seq,
    type,
    class: entry.eventClass,
    v: version,
    actor,
    causation,
    ts,
    payload: parsedPayload,
  } as TypedEvent;
}

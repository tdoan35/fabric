// The upcaster registry (RUNTIME §10): old payloads are upgraded on read, never rewritten.
// Keyed by (type, fromVersion); each entry lifts a payload exactly one version.
import { z } from "zod";
import { EVENT_CLASSES, EVENT_PAYLOAD_SCHEMAS, type EventClass } from "./schemas";

/** Lifts a payload from one version to the next. */
export type Upcaster = (payload: unknown) => unknown;

export interface EventTypeRegistration {
  type: string;
  /** Defaults to `"fact"` for newly registered types. */
  eventClass?: EventClass;
  /** The schema of the latest version; earlier versions are validated after upcasting. */
  schema: z.ZodType;
  /** `fromVersion → upcaster` to the next version, 1..latest-1. */
  upcasters?: Record<number, Upcaster>;
}

interface Entry {
  schema: z.ZodType;
  eventClass: EventClass;
  latest: number;
  upcasters: Map<number, Upcaster>;
}

const registry = new Map<string, Entry>();

for (const [type, schema] of Object.entries(EVENT_PAYLOAD_SCHEMAS)) {
  registry.set(type, {
    schema,
    eventClass: EVENT_CLASSES[type as keyof typeof EVENT_CLASSES],
    latest: 1,
    upcasters: new Map(),
  });
}

/** Register a type (test-only types, or a new version of an existing one). */
export function registerEventType(registration: EventTypeRegistration): void {
  const upcasters = new Map<number, Upcaster>(
    Object.entries(registration.upcasters ?? {}).map(([from, upcast]) => [Number(from), upcast])
  );
  const latest = upcasters.size === 0 ? 1 : Math.max(...upcasters.keys()) + 1;
  registry.set(registration.type, {
    schema: registration.schema,
    eventClass: registration.eventClass ?? "fact",
    latest,
    upcasters,
  });
}

/** The latest known version of a type; 0 when the type is unknown. */
export function latestVersion(type: string): number {
  return registry.get(type)?.latest ?? 0;
}

/** Internal lookup for `parseEvent`; undefined for unknown types. */
export function entryFor(type: string): Entry | undefined {
  return registry.get(type);
}

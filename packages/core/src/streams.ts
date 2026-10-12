// Stream identities (RUNTIME §2): one append-only log per session, per run and per agent.
// Pure string shapes — the db layer owns the rows these name.

/** The three stream kinds and their id prefixes. */
export const STREAM_PREFIXES = ["session", "run", "agent"] as const;

export type StreamKind = (typeof STREAM_PREFIXES)[number];

export interface ParsedStreamId {
  kind: StreamKind;
  id: string;
}

/** Builders for the three stream id shapes. */
export const streamId = {
  session: (id: string): string => `session:${id}`,
  run: (id: string): string => `run:${id}`,
  agent: (id: string): string => `agent:${id}`,
};

/** Parse `session:<id>` / `run:<id>` / `agent:<id>`; any other shape is rejected. */
export function parseStreamId(raw: string): ParsedStreamId {
  const sep = raw.indexOf(":");
  const kind = sep === -1 ? "" : raw.slice(0, sep);
  if (!(STREAM_PREFIXES as readonly string[]).includes(kind)) {
    throw new Error(
      `invalid stream id ${JSON.stringify(raw)}: expected one of ${STREAM_PREFIXES.map(
        (prefix) => `${prefix}:<id>`
      ).join(", ")}`
    );
  }
  const id = raw.slice(sep + 1);
  if (id.length === 0) {
    throw new Error(`invalid stream id ${JSON.stringify(raw)}: the id part is empty`);
  }
  return { kind: kind as StreamKind, id };
}

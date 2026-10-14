// Pkt-line parsing (ANY-44 T11): the ref-update commands of a
// git-receive-pack request, read only up to the flush packet — the pack
// that follows is never consumed.

export type PktCommand = {
  old: string;
  new: string;
  ref: string;
  /** Capabilities, only ever present on the first command (after the NUL). */
  caps?: string;
};

export type ParsedPktLines = {
  commands: PktCommand[];
  /** Offset just past the flush packet: everything after is pack data. */
  consumed: number;
  /** `complete` once the flush is read; `incomplete` when the input ends
   * before it (more bytes may complete it); `malformed` otherwise. */
  state: "complete" | "incomplete" | "malformed";
};

const FLUSH = "0000";
const PKT_LENGTH = /^[0-9a-f]{4}$/;

/**
 * Parses `<old> <new> <ref>\0<caps>` command lines until the flush packet.
 * Stops there: `consumed` is the offset where the pack begins, and the
 * parser never reads past it (a body truncated at `consumed` parses the
 * same). Anything short of a complete section consumes nothing — `commands`
 * comes back empty.
 */
export function parsePktLines(body: Uint8Array): ParsedPktLines {
  const commands: PktCommand[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const lengthHex = String.fromCharCode(body[offset], body[offset + 1], body[offset + 2], body[offset + 3]);
    if (lengthHex === FLUSH) return { commands, consumed: offset + 4, state: "complete" };
    const length = PKT_LENGTH.test(lengthHex) ? Number.parseInt(lengthHex, 16) : Number.NaN;
    if (!Number.isFinite(length) || length < 4) {
      return { commands: [], consumed: 0, state: "malformed" };
    }
    if (offset + length > body.length) break;
    const payload = Buffer.from(body.subarray(offset + 4, offset + length)).toString("utf8").replace(/\n$/, "");
    const [ids, caps = undefined] = payload.split("\0", 2);
    const parts = ids.split(" ");
    if (parts.length >= 3) {
      commands.push({ old: parts[0], new: parts[1], ref: parts.slice(2).join(" "), ...(caps === undefined ? {} : { caps }) });
    }
    offset += length;
  }
  return { commands: [], consumed: 0, state: "incomplete" };
}

/** One pkt-line: 4 hex length bytes (counting themselves) + payload. */
export function pktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0"), "ascii"), body]);
}

export const FLUSH_PKT = Buffer.from(FLUSH, "ascii");

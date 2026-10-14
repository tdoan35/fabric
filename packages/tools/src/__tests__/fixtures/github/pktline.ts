// Pkt-line fixtures for the git push tests (ANY-44 T11). Everything the
// tests push is built here — no network, no real packfiles beyond opaque
// bytes the parser must never touch.
import { createHash } from "node:crypto";

export const ZERO_SHA = "0".repeat(40);

/** A deterministic 40-hex stand-in for an object id. */
export function sha(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

/** One pkt-line: 4 hex length bytes (counting themselves) + payload. */
export function pktLine(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0"), "ascii"), body]);
}

export const FLUSH_PKT = Buffer.from("0000", "ascii");

export type RefUpdate = { old: string; new: string; ref: string };

/** A `git-receive-pack` request body: ref-update commands (capabilities on
 * the first, after a NUL), a flush, then the pack — which the parser must
 * never consume. */
export function buildPushBody(commands: readonly RefUpdate[], caps: string, pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  commands.forEach((command, index) => {
    const line =
      index === 0 ? `${command.old} ${command.new} ${command.ref}\0${caps}\n` : `${command.old} ${command.new} ${command.ref}\n`;
    parts.push(pktLine(line));
  });
  parts.push(FLUSH_PKT, pack);
  return Buffer.concat(parts);
}

/** Opaque pack stand-in — real bytes, meaningless content. */
export function fakePack(): Buffer {
  return Buffer.concat([Buffer.from("PACK"), Buffer.alloc(64, 7)]);
}

/** The pkt-line payloads of a body up to its first flush, as text. */
function pktPayloads(body: Buffer): Buffer[] {
  const payloads: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(body.subarray(offset, offset + 4).toString("ascii"), 16);
    if (length === 0) break;
    payloads.push(body.subarray(offset + 4, offset + length));
    offset += length;
  }
  return payloads;
}

/** A receive-pack result's report-status lines (`unpack ok`, `ng <ref>
 * <reason>`, …), unwrapping side-band channel 1 when `sideBand` is set. */
export function reportStatusLines(body: Buffer, sideBand = false): string[] {
  let status = body;
  if (sideBand) {
    const frames = pktPayloads(body);
    if (frames.some((frame) => frame[0] !== 1)) throw new Error("expected only band-1 frames");
    status = Buffer.concat(frames.map((frame) => frame.subarray(1)));
  }
  return pktPayloads(status).map((payload) => payload.toString("utf8").replace(/\n$/, ""));
}

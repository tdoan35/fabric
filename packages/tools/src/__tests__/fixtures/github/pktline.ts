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

// ANY-44 T11 — the pkt-line ref-update parser (GH3). The fixture body has
// three ref updates (capabilities on the first), a flush, then pack bytes
// the parser must never consume.
import { expect, test } from "vitest";
import { FLUSH_PKT, buildPushBody, fakePack, sha } from "./fixtures/github/pktline";
import { parsePktLines } from "../broker/github";

const COMMANDS = [
  { old: sha("old-1"), new: sha("new-1"), ref: "refs/heads/fabric/fix-1" },
  { old: sha("old-2"), new: sha("new-2"), ref: "refs/heads/fabric/fix-2" },
  { old: sha("old-3"), new: sha("new-3"), ref: "refs/heads/fabric/fix-3" },
];
const CAPS = "report-status side-band-64k agent=git/2.43.0";
const PACK = fakePack();
const BODY = buildPushBody(COMMANDS, CAPS, PACK);

test("GH3 pkt-line parsing yields the ref commands and stops at the flush packet", () => {
  const parsed = parsePktLines(BODY);

  expect(parsed.commands).toHaveLength(3);
  expect(parsed.commands[0]).toEqual({ ...COMMANDS[0], caps: CAPS });
  expect(parsed.commands[1]).toEqual({ ...COMMANDS[1], caps: undefined });
  expect(parsed.commands[2]).toEqual({ ...COMMANDS[2], caps: undefined });

  // `consumed` is the offset just past the flush packet, before the pack.
  const flushAt = BODY.indexOf(FLUSH_PKT);
  expect(flushAt).toBeGreaterThan(0);
  expect(parsed.consumed).toBe(flushAt + FLUSH_PKT.length);
  expect(BODY.subarray(parsed.consumed).equals(PACK)).toBe(true);

  // The parser works on the commands alone: the pack bytes are never read.
  const withoutPack = parsePktLines(BODY.subarray(0, parsed.consumed));
  expect(withoutPack.commands).toEqual(parsed.commands);
  expect(withoutPack.consumed).toBe(parsed.consumed);
});

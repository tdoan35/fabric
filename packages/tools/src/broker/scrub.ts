// The scrubbing backstop (ANY-44 T5, D3): known secret values must never
// reach a terminal line or an error string, whatever form they take — raw,
// base64 or URL-encoded. makeScrubber builds the replacement pass;
// withScrubbing wraps any ToolPort so its onLine lines and error strings are
// scrubbed. registry.ts is untouched — it belongs to the tools-core track.
import type { ToolPort } from "@fabric/runtime";

export type Scrubber = (text: string) => string;

/** Values below this length are too likely to collide with ordinary text. */
const MIN_VALUE_LENGTH = 8;

export function makeScrubber(values: readonly { name: string; value: string }[]): Scrubber {
  const replacements: { needle: string; replacement: string }[] = [];
  for (const { name, value } of values) {
    if (value.length < MIN_VALUE_LENGTH) continue;
    const forms = new Set([
      value,
      Buffer.from(value, "utf8").toString("base64"),
      encodeURIComponent(value),
    ]);
    for (const needle of forms) {
      replacements.push({ needle, replacement: `[redacted:${name}]` });
    }
  }
  // Longest first, so overlapping encodings replace cleanly.
  replacements.sort((a, b) => b.needle.length - a.needle.length);

  return (text) => {
    let scrubbed = text;
    for (const { needle, replacement } of replacements) {
      if (!scrubbed.includes(needle)) continue;
      scrubbed = scrubbed.split(needle).join(replacement);
    }
    return scrubbed;
  };
}

export function withScrubbing(port: ToolPort, scrub: Scrubber): ToolPort {
  return {
    describe: port.describe,
    async run(name, args, io) {
      const downstream = io.onLine;
      const result = await port.run(name, args, {
        onLine: downstream === undefined ? undefined : (line) => downstream(scrub(line)),
      });
      return result.error === undefined ? result : { ...result, error: scrub(result.error) };
    },
  };
}

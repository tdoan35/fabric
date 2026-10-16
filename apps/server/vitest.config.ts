import { defineConfig } from "vitest/config";

// The server suites boot a full runtime per test — PGlite wasm init, the db
// migrations, and (since the M-merge) the skills/vault/MCP schema ensures —
// which lands whole seconds on the first test of every file. The default
// 5 s test timeout is margin too thin for that on a loaded machine (the
// first test of the heavy fixtures clocked 5.7-7.6 s); 20 s keeps every
// assertion able to fail while giving the boots room. Same shape as
// packages/runtime/vitest.config.ts.
export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The MCP seam tests boot embedded PGlite and a real MCP server over HTTP;
    // under a loaded machine (CI's parallel workspaces) that is not free.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

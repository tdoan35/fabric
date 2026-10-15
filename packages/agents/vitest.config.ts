import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The session suites boot embedded PGlite stores; under the full run that
    // busts the 5s default (the same budget runtime and tools carry).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

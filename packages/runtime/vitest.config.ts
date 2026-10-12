import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The Postgres leg waits on a real server; the per-test database create is not free.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

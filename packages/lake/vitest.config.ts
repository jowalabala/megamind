import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each file starts its own Postgres container.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});

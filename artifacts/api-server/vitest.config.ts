import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    forks: { singleFork: true },
    setupFiles: ["src/__tests__/_setup/forceSandboxPlaidEnv.ts"],
  },
});

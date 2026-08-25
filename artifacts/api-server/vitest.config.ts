import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    forks: { singleFork: true },
    // ⚠️ SERIAL ON PURPOSE. `singleFork` puts every file in ONE process but does
    // NOT stop Vitest from interleaving files inside it, and these are
    // integration tests against ONE Postgres: interleaved files were writing
    // over each other's rows. The tell was `plaidRefreshUserRetry`'s cron-path
    // case failing roughly one run in three with a stamp it had just seeded read
    // back as null — never once when that file ran alone (6/6 green), never
    // again with parallelism off (3/3 full-suite green). Serial costs ~60s on a
    // ~23s suite; a test that fails one time in three costs far more than that,
    // because the first thing it does is send you looking for a bug you did not
    // write.
    fileParallelism: false,
    setupFiles: ["src/__tests__/_setup/forceSandboxPlaidEnv.ts"],
  },
});

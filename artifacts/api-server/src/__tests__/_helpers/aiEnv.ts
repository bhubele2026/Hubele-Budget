import { afterAll, beforeAll } from "vitest";

/**
 * (AI-0) Pin env keys for one test file and put them back afterwards — the
 * API suite runs every file in ONE process, so an env change would otherwise
 * leak into the next file.
 */
export function pinEnv(values: Record<string, string | undefined>): void {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [k, v] of Object.entries(values)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const k of Object.keys(values)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

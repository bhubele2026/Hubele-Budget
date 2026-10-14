import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

const fetchVersion = vi.hoisted(() => vi.fn());

vi.mock("@workspace/api-client-react", () => ({
  getGetVersionQueryKey: () => ["/api/version"],
  useGetVersion: (opts: { query: Record<string, unknown> }) =>
    useQuery({ ...(opts.query as object), queryFn: fetchVersion } as never),
}));
vi.mock("@/lib/version", () => ({ APP_VERSION: "build-1" }));
vi.mock("wouter", () => ({ useLocation: () => ["/home"] }));

import { VersionUpdatePrompt } from "./version-update-prompt";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fetchVersion.mockReset();
});

describe("VersionUpdatePrompt", () => {
  it("asks /version once per load, not twice", async () => {
    vi.stubEnv("PROD", true);
    vi.useFakeTimers();
    fetchVersion.mockResolvedValue({ version: "build-1" });
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <VersionUpdatePrompt />
      </QueryClientProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchVersion).toHaveBeenCalledTimes(1);
  });
});

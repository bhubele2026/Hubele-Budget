import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { getGetSpineQueryKey } from "@workspace/api-client-react";
import { askForSpineAgainIfFailed } from "./spineRecovery";

const queryKey = getGetSpineQueryKey();
const SPINE = { asOf: "2026-09-11" };

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** The app's own query defaults (`retry: 1`), without the wait between tries. */
function appClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
}

/** Lets any request the helper started settle before counting calls. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A spine request that stays out until the test answers it. */
function heldRequest() {
  const held: { succeed: (v: unknown) => void; fail: (e: Error) => void } = {
    succeed: () => {},
    fail: () => {},
  };
  const run = () =>
    new Promise((resolve, reject) => {
      held.succeed = resolve;
      held.fail = reject;
    });
  return { held, run };
}

describe("askForSpineAgainIfFailed", () => {
  it("asks again when the prefetch already failed with nothing to show", async () => {
    const qc = client();
    const queryFn = vi.fn().mockRejectedValueOnce(new Error("401")).mockResolvedValue(SPINE);
    await qc.prefetchQuery({ queryKey, queryFn });
    expect(qc.getQueryState(queryKey)?.status).toBe("error");

    askForSpineAgainIfFailed(qc);

    await vi.waitFor(() => expect(qc.getQueryData(queryKey)).toEqual(SPINE));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("waits for a prefetch still in flight, and asks again when it fails after sign-in", async () => {
    const qc = client();
    const { held, run } = heldRequest();
    const queryFn = vi.fn().mockImplementationOnce(run).mockResolvedValue(SPINE);
    const prefetch = qc.prefetchQuery({ queryKey, queryFn });
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    const stop = askForSpineAgainIfFailed(qc);
    expect(queryFn).toHaveBeenCalledTimes(1);

    held.fail(new Error("401"));
    await prefetch;
    await vi.waitFor(() => expect(qc.getQueryData(queryKey)).toEqual(SPINE));
    expect(queryFn).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not ask again when the prefetch in flight succeeds", async () => {
    const qc = client();
    const { held, run } = heldRequest();
    const queryFn = vi.fn().mockImplementation(run);
    const prefetch = qc.prefetchQuery({ queryKey, queryFn });
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    askForSpineAgainIfFailed(qc);
    held.succeed(SPINE);
    await prefetch;
    await settle();

    expect(qc.getQueryData(queryKey)).toEqual(SPINE);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("asks once, never in a loop, when the server keeps failing", async () => {
    const qc = client();
    const { held, run } = heldRequest();
    const queryFn = vi.fn().mockImplementationOnce(run).mockRejectedValue(new Error("500"));
    const prefetch = qc.prefetchQuery({ queryKey, queryFn });
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    askForSpineAgainIfFailed(qc);
    held.fail(new Error("401"));
    await prefetch;

    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(qc.getQueryState(queryKey)?.fetchStatus).toBe("idle"));
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(qc.getQueryState(queryKey)?.status).toBe("error");
  });

  it("leaves a failed refresh with numbers on screen to the banner's Retry", async () => {
    const qc = client();
    qc.setQueryData(queryKey, SPINE);
    const queryFn = vi.fn().mockRejectedValue(new Error("500"));
    await qc.prefetchQuery({ queryKey, queryFn, staleTime: 0 });
    expect(qc.getQueryState(queryKey)).toMatchObject({ status: "error", data: SPINE });

    askForSpineAgainIfFailed(qc);
    await settle();

    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the spine was never asked for", () => {
    const qc = client();
    const stop = askForSpineAgainIfFailed(qc);
    expect(qc.getQueryCache().findAll()).toHaveLength(0);
    expect(() => stop()).not.toThrow();
  });
});

/**
 * The path the real bug takes. During the optimistic shell the nav's review
 * count mounts a spine observer that JOINS the prefetch, and it survives the
 * sign-in commit. That observer makes the query active and gives it the app's
 * `retry: 1`.
 */
describe("askForSpineAgainIfFailed — with a page's spine reader already mounted", () => {
  it("the reader joins the prefetch, and the recovery makes exactly one more request", async () => {
    const qc = appClient();
    const { held, run } = heldRequest();
    const queryFn = vi.fn().mockImplementationOnce(run).mockResolvedValue(SPINE);
    const prefetch = qc.prefetchQuery({ queryKey, queryFn, retry: false });
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    const reader = new QueryObserver(qc, { queryKey, queryFn });
    const unmountReader = reader.subscribe(() => {});
    expect(queryFn).toHaveBeenCalledTimes(1);

    const stop = askForSpineAgainIfFailed(qc);
    held.fail(new Error("401"));
    await prefetch;

    await vi.waitFor(() => expect(reader.getCurrentResult().data).toEqual(SPINE));
    expect(queryFn).toHaveBeenCalledTimes(2);
    stop();
    unmountReader();
  });

  it("stays bounded when the server keeps failing: one ask, tried twice under the app's retry", async () => {
    const qc = appClient();
    const { held, run } = heldRequest();
    const queryFn = vi.fn().mockImplementationOnce(run).mockRejectedValue(new Error("500"));
    const prefetch = qc.prefetchQuery({ queryKey, queryFn, retry: false });
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    const reader = new QueryObserver(qc, { queryKey, queryFn });
    const unmountReader = reader.subscribe(() => {});

    const stop = askForSpineAgainIfFailed(qc);
    held.fail(new Error("401"));
    await prefetch;

    await vi.waitFor(() =>
      expect(qc.getQueryState(queryKey)).toMatchObject({ status: "error", fetchStatus: "idle" }),
    );
    await settle();
    await settle();
    // The failed prefetch, then the one ask: its first try and the app's one retry.
    expect(queryFn).toHaveBeenCalledTimes(3);
    stop();
    unmountReader();
  });
});

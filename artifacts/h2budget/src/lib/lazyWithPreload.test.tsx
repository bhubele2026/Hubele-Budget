import { describe, it, expect, vi, afterEach } from "vitest";
import { Suspense } from "react";
import { render, screen, act, cleanup } from "@testing-library/react";
import { lazyWithPreload } from "./lazyWithPreload";

const Page = () => <div data-testid="page">page</div>;

afterEach(cleanup);

describe("lazyWithPreload", () => {
  it("renders without the Suspense fallback once the chunk is preloaded", async () => {
    const importer = vi.fn(() => Promise.resolve({ default: Page }));
    const Lazy = lazyWithPreload(importer);
    await act(async () => {
      await Lazy.preload();
    });
    render(
      <Suspense fallback={<div data-testid="fallback" />}>
        <Lazy />
      </Suspense>,
    );
    // Synchronous: the very first commit already has the page.
    expect(screen.getByTestId("page")).toBeTruthy();
    expect(screen.queryByTestId("fallback")).toBeNull();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("shows the fallback on a genuine cold load, then the page", async () => {
    let release: (m: { default: typeof Page }) => void = () => {};
    const importer = () => new Promise<{ default: typeof Page }>((r) => (release = r));
    const Lazy = lazyWithPreload(importer);
    render(
      <Suspense fallback={<div data-testid="fallback" />}>
        <Lazy />
      </Suspense>,
    );
    expect(screen.getByTestId("fallback")).toBeTruthy();
    await act(async () => release({ default: Page }));
    expect(await screen.findByTestId("page")).toBeTruthy();
  });

  it("shares one load between preload and render, and forgets a failure", async () => {
    const importer = vi
      .fn<() => Promise<{ default: typeof Page }>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ default: Page });
    const Lazy = lazyWithPreload(importer);
    await expect(Lazy.preload()).rejects.toThrow("offline");
    await Lazy.preload();
    await Lazy.preload();
    expect(importer).toHaveBeenCalledTimes(2);
  });
});

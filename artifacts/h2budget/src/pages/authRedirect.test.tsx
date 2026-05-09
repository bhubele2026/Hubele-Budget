import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import React from "react";

const redirectCalls: string[] = [];

vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    Redirect: ({ to }: { to: string }) => {
      redirectCalls.push(to);
      return null;
    },
  };
});

vi.mock("@clerk/react", () => ({
  SignIn: () => <div data-testid="signin-form" />,
  SignUp: () => <div data-testid="signup-form" />,
}));

import { SignUpPage } from "./auth";

beforeEach(() => {
  redirectCalls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("SignUpPage gate (invite-only)", () => {
  it("redirects to /sign-in when no Clerk invitation ticket is present", () => {
    window.history.replaceState({}, "", "/sign-up");
    render(
      <WouterRouter base="">
        <SignUpPage />
      </WouterRouter>,
    );
    expect(redirectCalls).toEqual(["/sign-in"]);
  });

  it("renders the SignUp form when arriving via a Clerk invitation ticket", () => {
    window.history.replaceState({}, "", "/sign-up?__clerk_ticket=abc123");
    const { getByTestId } = render(
      <WouterRouter base="">
        <SignUpPage />
      </WouterRouter>,
    );
    expect(redirectCalls).toEqual([]);
    expect(getByTestId("signup-form")).toBeTruthy();
  });

  it("keeps the SignUp form mounted when Clerk navigates to a sub-path that drops the ticket query string", () => {
    // Initial landing from the invite email URL.
    window.history.replaceState({}, "", "/sign-up?__clerk_ticket=abc123");
    const { getByTestId, rerender } = render(
      <WouterRouter base="">
        <SignUpPage />
      </WouterRouter>,
    );
    expect(getByTestId("signup-form")).toBeTruthy();

    // Clerk's internal flow pushes the user to /sign-up/verify-email-address
    // *without* the original ?__clerk_ticket query string, then re-renders.
    // We must NOT bounce to /sign-in or unmount the SignUp surface.
    window.history.replaceState({}, "", "/sign-up/verify-email-address");
    rerender(
      <WouterRouter base="">
        <SignUpPage />
      </WouterRouter>,
    );
    expect(redirectCalls).toEqual([]);
    expect(getByTestId("signup-form")).toBeTruthy();
  });

  it("recovers the SignUp form when the user lands directly on a Clerk sub-path (e.g. refresh mid-flow)", () => {
    window.history.replaceState({}, "", "/sign-up/verify-email-address");
    const { getByTestId } = render(
      <WouterRouter base="">
        <SignUpPage />
      </WouterRouter>,
    );
    expect(redirectCalls).toEqual([]);
    expect(getByTestId("signup-form")).toBeTruthy();
  });
});

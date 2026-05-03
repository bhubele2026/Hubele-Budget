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
});

import { describe, expect, it } from "vitest";
import { mustClearForClerkUser } from "./clerkUserSwitch";

describe("mustClearForClerkUser", () => {
  it("a change of user after the first word always clears; the same user never does", () => {
    expect(mustClearForClerkUser("u1", "u2", "u1")).toBe(true);
    expect(mustClearForClerkUser("u1", null, "u1")).toBe(true);
    expect(mustClearForClerkUser("u1", "u1", "u1")).toBe(false);
  });
  it("Clerk's first word clears what the cookie fetched for someone else", () => {
    expect(mustClearForClerkUser(undefined, "u2", "u1")).toBe(true);
  });
  it("Clerk's first word keeps what was fetched for the same user, or when nothing says whose it is yet", () => {
    expect(mustClearForClerkUser(undefined, "u1", "u1")).toBe(false);
    expect(mustClearForClerkUser(undefined, "u1", undefined)).toBe(false);
    expect(mustClearForClerkUser(undefined, null, "u1")).toBe(false); // signed out is cleared by the isSignedIn effect
  });
});

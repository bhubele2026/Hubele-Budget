import { describe, expect, it } from "vitest";
import { freshOpenTarget } from "./landingRedirect";

const base = { search: "", hash: "", navType: "navigate", referrer: "", origin: "https://h2budget.onrender.com" };

describe("a fresh open of bare /banking lands on the Dashboard", () => {
  it("typed, autocompleted or bookmarked /banking goes home", () => {
    expect(freshOpenTarget({ ...base, path: "/banking" })).toBe("/home");
    expect(freshOpenTarget({ ...base, path: "/banking/" })).toBe("/home");
  });
  it("a restored tab or a return from another site goes home", () => {
    expect(freshOpenTarget({ ...base, path: "/banking", navType: "back_forward" })).toBe("/home");
    expect(freshOpenTarget({ ...base, path: "/banking", referrer: "https://www.google.com/" })).toBe("/home");
  });
  it("a reload keeps Banking", () => {
    expect(freshOpenTarget({ ...base, path: "/banking", navType: "reload" })).toBeNull();
  });
  it("an open from inside the app keeps Banking", () => {
    expect(freshOpenTarget({ ...base, path: "/banking", referrer: "https://h2budget.onrender.com/home" })).toBeNull();
  });
  it("a link with a query or hash keeps Banking", () => {
    expect(freshOpenTarget({ ...base, path: "/banking", hash: "#needs-you" })).toBeNull();
    expect(freshOpenTarget({ ...base, path: "/banking", search: "?account=x" })).toBeNull();
  });
  it("other pages are untouched", () => {
    expect(freshOpenTarget({ ...base, path: "/amex" })).toBeNull();
    expect(freshOpenTarget({ ...base, path: "/home" })).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { offsetWithinScroller, shellScrollerOf, SHELL_SCROLLER_ATTR } from "./shellScroll";

describe("shellScroll — finding the shell's <main>", () => {
  it("finds the nearest shell scroller, and null outside the shell", () => {
    document.body.innerHTML = `<main ${SHELL_SCROLLER_ATTR}=""><div><p id="in">x</p></div></main><p id="out">y</p>`;
    expect(shellScrollerOf(document.getElementById("in"))?.tagName).toBe("MAIN");
    expect(shellScrollerOf(document.getElementById("out"))).toBeNull();
    expect(shellScrollerOf(null)).toBeNull();
  });

  it("the offset inside the scroller's content is rect delta + scrollTop, whatever the scroll", () => {
    document.body.innerHTML = `<main ${SHELL_SCROLLER_ATTR}=""><div id="list"></div></main>`;
    const main = document.querySelector("main")!;
    const list = document.getElementById("list")!;
    const rect = (top: number) => ({ top, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    main.getBoundingClientRect = () => rect(77);
    // Unscrolled: the list starts 600 px into <main>.
    list.getBoundingClientRect = () => rect(677);
    expect(offsetWithinScroller(list, main)).toBe(600);
    // Scrolled 250 px: the list moved up on screen; its offset did not change.
    Object.defineProperty(main, "scrollTop", { value: 250, configurable: true });
    list.getBoundingClientRect = () => rect(427);
    expect(offsetWithinScroller(list, main)).toBe(600);
  });
});

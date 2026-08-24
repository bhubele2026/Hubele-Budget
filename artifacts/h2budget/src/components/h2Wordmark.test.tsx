import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { H2Wordmark } from "./h2-wordmark";

/**
 * The wordmark has to be the same shape at 20px in a header rail and at ~400px
 * as the landing watermark. That is only true while every dimension stays a
 * ratio of `size` — the moment one is hard-coded the two sizes drift into
 * separate marks, which is the failure the PNG it replaced actually had.
 */

const box = () => screen.getByRole("img").firstElementChild as HTMLElement;

afterEach(cleanup);

describe("H2Wordmark", () => {
  it("announces once, as a name — not as three fragments", () => {
    render(<H2Wordmark tone="navy" />);
    const el = screen.getByRole("img");
    expect(el.getAttribute("aria-label")).toBe("H2 Budget");
    expect(el.textContent).toBe("H2Budget");
  });

  it("scales the box, the glyphs and the corner together", () => {
    render(<H2Wordmark tone="navy" size={100} />);
    const s = box().style;
    expect(s.width).toBe("100px");
    expect(s.height).toBe("100px");
    expect(s.fontSize).toBe("50px"); // 0.5 x box
    expect(s.borderRadius).toBe("28px"); // 0.28 x box
  });

  it("keeps the corner on --radius-control at the header size", () => {
    // 26px box x 0.28 = 7.3 -> 7px; the app's control radius is 8px, and this
    // is the size the ratio was chosen to land on.
    render(<H2Wordmark tone="navy" size={26} />);
    expect(box().style.borderRadius).toBe("7px");
  });

  it("thickens the ring on the SQUARE ROOT of the box, not linearly", () => {
    // Linear scaling would put a 15px frame on the watermark. Optical scaling
    // keeps a hairline reading as a hairline.
    render(<H2Wordmark tone="white" size={26} />);
    expect(box().style.boxShadow).toContain("1px");
    cleanup();
    render(<H2Wordmark tone="white" size={416} />);
    expect(box().style.boxShadow).toContain("4px");
  });

  it("draws both tones rather than filtering one out of the other", () => {
    render(<H2Wordmark tone="navy" />);
    // Solid navy ground, letters knocked out.
    expect(box().style.background).toContain("rgb(25, 49, 91)");
    expect(box().style.boxShadow).toBe("");
    cleanup();
    render(<H2Wordmark tone="white" />);
    // A ring on whatever navy it is sitting on — no fill of its own.
    expect(box().style.background).toBe("");
    expect(box().style.boxShadow).toContain("rgba(255,255,255,0.82)");
  });

  it("spends the one accent colour on the 2, in both tones", () => {
    for (const tone of ["navy", "white"] as const) {
      render(<H2Wordmark tone={tone} />);
      const two = screen.getByText("2");
      expect(two.style.color).toBe("rgb(246, 141, 46)");
      cleanup();
    }
  });
});

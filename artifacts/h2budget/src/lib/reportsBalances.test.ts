import { describe, it, expect } from "vitest";
import {
  resolveAmexRevolvingBalance,
  describeAmexRevolvingCards,
  type AmexCardAccountLike,
} from "./reportsBalances";

// (#875) The Amex tile now sources its two revolving cards from the
// Amex card-account list (Plaid liability accounts), NOT the household
// debts list. These fixtures mirror that shape: an `institutionName`
// issuer field plus a real `mask`.
const amexCard = (
  name: string,
  balance: AmexCardAccountLike["balance"],
  extra: Partial<AmexCardAccountLike> = {},
): AmexCardAccountLike => ({
  name,
  balance,
  institutionName: "American Express",
  ...extra,
});

describe("resolveAmexRevolvingBalance", () => {
  it("sums Blue Cash Preferred and Platinum when both are present", () => {
    const out = resolveAmexRevolvingBalance([
      amexCard("Blue Cash Preferred Card", "100.00", { mask: "1006" }),
      amexCard("Platinum Card", "250.50", { mask: "1009" }),
    ]);
    expect(out.found).toBe(true);
    expect(out.availableCount).toBe(2);
    expect(out.total).toBeCloseTo(350.5);
    expect(out.blueCash.available).toBe(true);
    expect(out.platinum.available).toBe(true);
  });

  it("totals only Blue Cash + the Amex Platinum and NEVER includes Capital One Platinum", () => {
    const out = resolveAmexRevolvingBalance([
      amexCard("Blue Cash Preferred Card", "100.00", { mask: "1006" }),
      amexCard("Platinum Card", "250.50", { mask: "1009" }),
      // Delta SkyMiles Gold (charge card) also ends 1009 — must be excluded.
      amexCard("Delta SkyMiles Gold Card", "9999.00", { mask: "1009" }),
      // A Capital One "Platinum" row — the historical bug (#875). Even if
      // it leaked into this Amex-scoped source, the issuer guard must
      // keep it out of the Amex total.
      {
        name: "Capital One Platinum",
        balance: "6560.84",
        mask: "4321",
        institutionName: "Capital One",
      },
    ]);
    // 100.00 + 250.50 only.
    expect(out.total).toBeCloseTo(350.5);
    expect(out.availableCount).toBe(2);
    // The notorious wrong number must never appear.
    expect(out.total).not.toBeCloseTo(6560.84);
    expect(out.blueCash.available).toBe(true);
    expect(out.platinum.available).toBe(true);
    // The Capital One row never contributed a mask or balance.
    expect(out.platinum.mask).toBe("1009");
  });

  it("shows Platinum plus an unavailable flag when Blue Cash balance is null", () => {
    const out = resolveAmexRevolvingBalance([
      amexCard("Blue Cash Preferred Card", null, { mask: "1006" }),
      amexCard("Platinum Card", "420.00", { mask: "1009" }),
    ]);
    expect(out.found).toBe(true);
    expect(out.availableCount).toBe(1);
    expect(out.total).toBeCloseTo(420);
    expect(out.blueCash.present).toBe(true);
    expect(out.blueCash.available).toBe(false);
    expect(out.platinum.available).toBe(true);
  });

  it("never includes Delta SkyMiles Gold even though it also ends 1009", () => {
    const out = resolveAmexRevolvingBalance([
      amexCard("Blue Cash Preferred Card", "100.00", { mask: "1006" }),
      amexCard("Delta SkyMiles Gold Card", "9999.00", { mask: "1009" }),
    ]);
    expect(out.total).toBeCloseTo(100);
    expect(out.availableCount).toBe(1);
    expect(out.platinum.present).toBe(false);
    expect(out.platinum.available).toBe(false);
    expect(out.blueCash.available).toBe(true);
  });

  it("does not match Platinum on Delta SkyMiles Gold and reports not found", () => {
    const out = resolveAmexRevolvingBalance([
      amexCard("Delta SkyMiles Gold Card", "500.00", { mask: "1009" }),
    ]);
    expect(out.found).toBe(false);
    expect(out.total).toBe(0);
    expect(out.availableCount).toBe(0);
  });

  it("excludes Blue Cash Everyday from the Blue Cash match", () => {
    const out = resolveAmexRevolvingBalance([
      amexCard("Blue Cash Everyday Card", "75.00", { mask: "2002" }),
    ]);
    expect(out.found).toBe(false);
    expect(out.blueCash.present).toBe(false);
    expect(out.blueCash.available).toBe(false);
  });

  it("never folds in a non-Amex-issued Platinum (issuer guard, defense in depth)", () => {
    const out = resolveAmexRevolvingBalance([
      // Capital One Platinum by institution.
      {
        name: "Platinum",
        balance: "6560.84",
        mask: "4321",
        institutionName: "Capital One",
      },
      // Chase "Platinum"-named card.
      {
        name: "Chase Platinum",
        balance: "1234.00",
        mask: "5678",
        institutionName: "Chase",
      },
    ]);
    expect(out.found).toBe(false);
    expect(out.total).toBe(0);
    expect(out.platinum.present).toBe(false);
  });

  it("returns not found when neither revolving card is present", () => {
    const out = resolveAmexRevolvingBalance([
      {
        name: "Chase Sapphire",
        balance: "300.00",
        institutionName: "Chase",
      },
    ]);
    expect(out.found).toBe(false);
    expect(out.total).toBe(0);
    expect(out.availableCount).toBe(0);
  });

  it("returns not found for empty or nullish input", () => {
    expect(resolveAmexRevolvingBalance([]).found).toBe(false);
    expect(resolveAmexRevolvingBalance(null).found).toBe(false);
    expect(resolveAmexRevolvingBalance(undefined).found).toBe(false);
  });

  it("ignores inactive cards and loan-type rows", () => {
    const out = resolveAmexRevolvingBalance([
      amexCard("Blue Cash Preferred Card", "100.00", {
        mask: "1006",
        status: "paid",
      }),
      amexCard("Platinum Card", "200.00", { mask: "1009", type: "loan" }),
    ]);
    expect(out.found).toBe(false);
    expect(out.total).toBe(0);
  });

  it("treats a bare 'Blue Cash' name as the Preferred card", () => {
    const out = resolveAmexRevolvingBalance([
      amexCard("Blue Cash", "60.00", { mask: "1006" }),
    ]);
    expect(out.blueCash.available).toBe(true);
    expect(out.total).toBeCloseTo(60);
  });

  it("matches Amex cards by issuer even when the name omits 'Amex'", () => {
    const out = resolveAmexRevolvingBalance([
      {
        name: "Blue Cash Preferred Card",
        balance: "100.00",
        mask: "1006",
        institutionSlug: "amex",
      },
    ]);
    expect(out.blueCash.available).toBe(true);
    expect(out.total).toBeCloseTo(100);
  });

  it("conservatively rejects a row with no Amex signal at all (no issuer, plain name)", () => {
    // Real Plaid liability-account rows always carry an institutionName
    // from their parent item, so this case shouldn't occur in practice.
    // We document the intended conservative behavior: with no Amex signal
    // from either the issuer fields or the name, the row is NOT folded in
    // — better to under-count than to mistake a foreign "Platinum Card".
    const out = resolveAmexRevolvingBalance([
      { name: "Platinum Card", balance: "999.00", mask: "1009" },
    ]);
    expect(out.found).toBe(false);
    expect(out.platinum.present).toBe(false);
    expect(out.total).toBe(0);
  });
});

describe("describeAmexRevolvingCards", () => {
  it("derives the sub-line from the cards actually found, with real masks", () => {
    const out = resolveAmexRevolvingBalance([
      amexCard("Blue Cash Preferred Card", "100.00", { mask: "1006" }),
      amexCard("Platinum Card", "250.50", { mask: "1009" }),
    ]);
    expect(describeAmexRevolvingCards(out)).toBe(
      "Blue Cash ••1006 + Platinum ••1009",
    );
  });

  it("flags a present-but-unavailable card as unavailable", () => {
    const out = resolveAmexRevolvingBalance([
      amexCard("Blue Cash Preferred Card", null, { mask: "1006" }),
      amexCard("Platinum Card", "420.00", { mask: "1009" }),
    ]);
    expect(describeAmexRevolvingCards(out)).toBe(
      "Blue Cash ••1006 + Platinum ••1009 (1 card unavailable)",
    );
  });

  it("omits a card that simply isn't linked (no false 'unavailable')", () => {
    const out = resolveAmexRevolvingBalance([
      amexCard("Platinum Card", "420.00", { mask: "1009" }),
    ]);
    expect(describeAmexRevolvingCards(out)).toBe("Platinum ••1009");
  });

  it("falls back to a friendly message when no Amex cards are linked", () => {
    const out = resolveAmexRevolvingBalance([]);
    expect(describeAmexRevolvingCards(out)).toBe("No Amex cards linked");
  });
});

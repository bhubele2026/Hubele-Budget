import type { AccountIdentity } from "@/lib/accountIdentity";

/**
 * The ONE account-aware sign rule for showing a stored transaction amount.
 * The ledger stores money out as negative on EVERY account (`plaidAmountToSigned`
 * flips Plaid's sign): a checking debit and a card purchase are both negative;
 * a deposit, a card refund and a card payment are all positive. So the display
 * number is the stored number, and a card charge reads as spending ("-$180.00"),
 * never as a credit. `identity` is taken so callers cannot skip the rule and so
 * an account kind that ever differs has one place to change.
 */
export function displayAmount(
  raw: string | number | null | undefined,
  identity?: Pick<AccountIdentity, "kind"> | null,
  source?: string | null,
): number {
  void identity;
  const n = typeof raw === "number" ? raw : parseFloat(raw ?? "");
  if (!Number.isFinite(n)) return 0;
  // ⚠️ The one exception: an Amex WORKBOOK row (`source` "amex", imported from
  // the spreadsheet) is stored the other way round, a charge POSITIVE and a
  // credit negative (the shared rule's `spendAmount` / `creditAmount`). Flip it
  // for display only, so a workbook charge reads "-$45.00" like every other
  // charge. The stored value is never touched.
  return source === "amex" && n !== 0 ? -n : n;
}

/** "-$180.00" for money out, "+$20.00" for credits, "$0.00" for zero. */
export function formatDisplayAmount(n: number): string {
  const abs = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(n));
  return n < 0 ? `-${abs}` : n > 0 ? `+${abs}` : abs;
}

/** Plain word for a positive amount on a card (a payment or a refund is a credit). */
export function creditWord(identity: Pick<AccountIdentity, "isCard">): string {
  return identity.isCard ? "Payment or refund" : "Deposit";
}

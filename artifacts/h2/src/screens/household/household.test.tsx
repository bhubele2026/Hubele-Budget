import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Invitation, MeResponse, Member, PlaidEnvironmentInfo, PlaidItemDetail, UiPreferences } from "@workspace/api-client-react";
import type { Read } from "@/data/todayData";

/**
 * ⭐ HOUSEHOLD READS ITS BANKS AND MEMBERS AND SENDS WHAT THE OWNER ASKS FOR.
 * The views are rendered on data they are handed and every hook that writes is
 * mocked at the boundary, so each test checks what was read off the screen and
 * exactly what was sent. The billing law is here: a plain Sync never carries
 * `force`; the billable pull is behind a disclosure AND a confirm.
 */
type Fn = ReturnType<typeof vi.fn>;
const mocks = vi.hoisted(() => ({
  sync: null as unknown as Fn,
  del: null as unknown as Fn,
  clear: null as unknown as Fn,
  linkToken: null as unknown as Fn,
  updateToken: null as unknown as Fn,
  exchange: null as unknown as Fn,
  bulk: null as unknown as Fn,
  prefs: null as unknown as Fn,
  invite: null as unknown as Fn,
  revoke: null as unknown as Fn,
  resend: null as unknown as Fn,
  removeMember: null as unknown as Fn,
  liabilities: null as unknown as Fn,
  liveItems: null as unknown as Fn,
  plaidOpen: null as unknown as Fn,
  plaidCfg: null as unknown as { token: string | null; onSuccess: (t: string, m: unknown) => void; onExit: () => void },
}));
vi.mock("react-plaid-link", () => ({
  usePlaidLink: (cfg: typeof mocks.plaidCfg) => {
    mocks.plaidCfg = cfg;
    return { open: mocks.plaidOpen, ready: true };
  },
}));
const hook = vi.hoisted(() => (key: keyof typeof mocks) => () => ({ mutate: mocks[key], mutateAsync: mocks[key], isPending: false }));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useSyncPlaidTransactions: hook("sync"),
    useDeletePlaidItem: hook("del"),
    useClearPlaidItemRefreshDisabled: hook("clear"),
    useCreatePlaidLinkToken: hook("linkToken"),
    useCreatePlaidUpdateLinkToken: hook("updateToken"),
    useExchangePlaidPublicToken: hook("exchange"),
    useBulkCreateDebtsFromPlaidAccounts: hook("bulk"),
    useCreateInvitation: hook("invite"),
    useRevokeInvitation: hook("revoke"),
    useResendInvitation: hook("resend"),
    useRemoveMember: hook("removeMember"),
    listPlaidLiabilityAccounts: (...a: unknown[]) => (mocks.liabilities as (...x: unknown[]) => unknown)(...a),
    listPlaidItems: (...a: unknown[]) => (mocks.liveItems as (...x: unknown[]) => unknown)(...a),
  };
});
vi.mock("@workspace/api-client-react/ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react/ledger")>();
  return { ...actual, useUpdateUiPreferences: hook("prefs") };
});

import { BanksView, type BanksData } from "./Household";
import { MembersView, type MembersData } from "./Members";

const NOW = new Date("2026-10-07T15:00:00Z");
const loaded = <T,>(data: T | undefined, over: Partial<Read<T>> = {}): Read<T> => ({
  data,
  state: data === undefined ? "cold" : "loaded",
  isFetching: false,
  refetch: vi.fn(),
  ...over,
});
const mount = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

const acct = (id: string, name: string, mask: string, subtype: string) => ({ id, accountId: `${id}-x`, name, mask, subtype, type: "depository" });
const item = (id: string, name: string, over: Partial<PlaidItemDetail> = {}): PlaidItemDetail =>
  ({ id, itemId: `plaid-${id}`, institutionName: name, institutionSlug: name, lastSyncedAt: "2026-10-07T14:48:00Z", accounts: [], ...over }) as PlaidItemDetail;
const OK = item("p1", "Sample Bank", { accounts: [acct("a1", "Checking", "0100", "checking"), acct("a2", "Savings", "0101", "savings")] });
const REAUTH = item("p2", "Sample Credit Union", { lastSyncErrorCode: "ITEM_LOGIN_REQUIRED", lastSyncError: "login", lastSyncedAt: "2026-10-04T14:48:00Z", accounts: [acct("a3", "Visa", "0200", "credit card")] });
const PREP = item("p3", "Sample Card Co", { stillPreparing: true, lastSyncedAt: null });
const STOPPED = item("p4", "Sample Savings Bank", { lastSyncError: "The bank is not answering" });
const ENV = { env: "production", configured: true, nonProdItemCount: 0, nonProdItems: [] } as PlaidEnvironmentInfo;
const PREFS = { autoCategorize: true } as UiPreferences;
const banks = (items: PlaidItemDetail[] | undefined, over: Partial<BanksData> = {}): BanksData => ({ items: loaded(items), env: loaded(ENV), prefs: loaded(PREFS), ...over });
const syncRes = (added: number, extra: Record<string, unknown> = {}) => ({ items: [{ itemId: "x", added, modified: 0, removed: 0, autoCategorized: 0, ruleAttributions: [], ...extra }] });

beforeEach(() => {
  for (const k of ["sync", "del", "clear", "linkToken", "updateToken", "exchange", "bulk", "prefs", "invite", "revoke", "resend", "removeMember", "liabilities", "liveItems", "plaidOpen"] as const) {
    mocks[k] = vi.fn();
  }
  mocks.sync.mockResolvedValue(syncRes(0));
  mocks.liabilities.mockResolvedValue([]);
  mocks.liveItems.mockResolvedValue([]);
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});
afterEach(cleanup);

describe("Banks — the list, in words", () => {
  it("each bank: name, accounts, last synced, one status word", () => {
    mount(<BanksView data={banks([OK, REAUTH, PREP, STOPPED])} now={NOW} />);
    const rows = screen.getAllByTestId("bank-row");
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["ok", "reconnect", "preparing", "stopped"]);
    expect(within(rows[0]!).getByTestId("bank-name").textContent).toBe("Sample Bank");
    expect(within(rows[0]!).getByTestId("bank-status").textContent).toBe("Working");
    expect(within(rows[0]!).getByTestId("bank-synced").textContent).toBe("Synced 12 minutes ago");
    expect(within(rows[0]!).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Checking · ending 0100 · checking", "Savings · ending 0101 · savings"]);
    expect(within(rows[1]!).getByTestId("bank-status").textContent).toBe("Needs reconnect");
    expect(within(rows[1]!).getByTestId("bank-detail").textContent).toMatch(/Sign in again|login expired/);
    expect(within(rows[2]!).getByTestId("bank-status").textContent).toBe("Preparing");
    expect(within(rows[2]!).getByTestId("bank-synced").textContent).toBe("Not synced yet");
    expect(within(rows[3]!).getByTestId("bank-status").textContent).toBe("Feed stopped");
    expect(within(rows[3]!).getByTestId("bank-detail").textContent).toBe("The bank is not answering");
  });

  it("only a bank that needs it offers Reconnect, and the page says so up top", () => {
    mount(<BanksView data={banks([OK, REAUTH])} now={NOW} />);
    expect(screen.queryByTestId("reconnect-p1")).toBeNull();
    expect(screen.getByTestId("reconnect-p2")).toBeTruthy();
    expect(screen.getByTestId("reauth-banner").textContent).toContain("Sample Credit Union needs reconnecting.");
  });

  it("states: skeleton, empty, failed with Retry, refresh failed keeps the list", async () => {
    const user = userEvent.setup();
    const { unmount } = mount(<BanksView data={banks(undefined)} now={NOW} />);
    expect(screen.getByTestId("banks-skeleton")).toBeTruthy();
    expect((screen.getByTestId("connect-bank") as HTMLButtonElement).disabled).toBe(true);
    unmount();
    const empty = mount(<BanksView data={banks([])} now={NOW} />);
    expect(screen.getByTestId("banks-empty").textContent).toContain("No bank is linked yet");
    empty.unmount();
    const refetch = vi.fn();
    const failed = mount(<BanksView data={banks(undefined, { items: loaded<PlaidItemDetail[]>(undefined, { state: "failed", refetch }) })} now={NOW} />);
    await user.click(within(screen.getByTestId("banks-error")).getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
    failed.unmount();
    mount(<BanksView data={banks([OK], { items: loaded([OK], { state: "refresh-failed" }) })} now={NOW} />);
    expect(screen.getAllByTestId("bank-row")).toHaveLength(1);
    expect(screen.getByText(/Couldn't refresh/)).toBeTruthy();
  });

  it("an unconfigured server disables Connect and says why", () => {
    mount(<BanksView data={banks([OK], { env: loaded({ ...ENV, configured: false, configError: "Plaid is not set up on this server." }) })} now={NOW} />);
    expect((screen.getByTestId("connect-bank") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Plaid is not set up on this server.")).toBeTruthy();
  });

  it("each bank shows its Automatic updates line under the last-synced line; Sync and Force stay", () => {
    mount(
      <BanksView
        data={banks([
          item("a", "Alpha", { autoUpdates: { on: true, reason: "ok", checkedAt: null, error: null } }),
          item("b", "Beta", { autoUpdates: { on: false, reason: "not_registered", checkedAt: null, error: null } }),
        ])}
        now={NOW}
      />,
    );
    const lines = screen.getAllByTestId("bank-auto-updates").map((n) => n.textContent);
    expect(lines).toEqual([
      "Automatic updates: On — the bank tells H2 when something changes.",
      "Automatic updates: Off — not registered yet; the next sync will register it.",
    ]);
    expect(screen.getAllByTestId("bank-synced")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^Sync/ }).length).toBeGreaterThan(0);
  });

  it("the classic app is named for what is not ported", () => {
    mount(<BanksView data={banks([OK])} now={NOW} />);
    const link = screen.getByTestId("classic-settings");
    expect(link.getAttribute("href")).toBe("/classic/settings");
    expect(link.textContent).toBe("classic app");
  });
});

describe("Sync is free; the fresh pull is billable and asked twice", () => {
  it("Sync sends the item and NO force; it shows Syncing… then the new-row count", async () => {
    const user = userEvent.setup();
    let release!: (v: unknown) => void;
    mocks.sync.mockReturnValue(new Promise((r) => (release = r)));
    mount(<BanksView data={banks([OK])} now={NOW} />);
    await user.click(screen.getByTestId("sync-p1"));
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.sync.mock.calls[0]![0]).toEqual({ data: { itemId: "p1" } });
    expect("force" in mocks.sync.mock.calls[0]![0].data).toBe(false);
    expect(screen.getByTestId("sync-p1").textContent).toBe("Syncing…");
    expect((screen.getByTestId("sync-p1") as HTMLButtonElement).disabled).toBe(true);
    release(syncRes(3));
    expect((await screen.findByTestId("sync-result-p1")).textContent).toBe("3 new");
    expect(screen.getByTestId("sync-p1").textContent).toBe("Sync");
  });

  it("a sync that finds nothing, or fails, says so in words", async () => {
    const user = userEvent.setup();
    mount(<BanksView data={banks([OK, STOPPED])} now={NOW} />);
    await user.click(screen.getByTestId("sync-p1"));
    expect((await screen.findByTestId("sync-result-p1")).textContent).toBe("Up to date. No new transactions.");
    mocks.sync.mockRejectedValue({ data: { error: "The bank said no." } });
    await user.click(screen.getByTestId("sync-p4"));
    expect((await screen.findByTestId("sync-result-p4")).textContent).toBe("The bank said no.");
  });

  it("Force refresh: the sentence is in a disclosure; clicking it asks; only the confirm sends force", async () => {
    const user = userEvent.setup();
    mocks.sync.mockResolvedValue(syncRes(1));
    mount(<BanksView data={banks([OK])} now={NOW} />);
    const sentence = "This asks the bank for a fresh pull and may cost a small fee.";
    const disclosure = screen.getByText("A pending charge is missing?").closest("details")!;
    expect(disclosure.textContent).toContain(sentence);
    expect(disclosure.open).toBe(false);
    await user.click(screen.getByTestId("force-p1"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(sentence);
    expect(mocks.sync).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Not now" }));
    expect(mocks.sync).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("force-p1"));
    await user.click(await screen.findByTestId("force-confirm"));
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.sync.mock.calls[0]![0]).toEqual({ data: { itemId: "p1", force: true } });
    expect((await screen.findByTestId("sync-result-p1")).textContent).toBe("1 new");
  });

  it("Re-enable fast refresh is billable too: it asks, then clears the stamp and pulls fresh", async () => {
    const user = userEvent.setup();
    mocks.clear.mockResolvedValue(undefined);
    mount(<BanksView data={banks([item("p5", "Sample Bank", { refreshProductDisabledAt: "2026-10-01T00:00:00Z" })])} now={NOW} />);
    await user.click(within(screen.getByTestId("refresh-paused-p5")).getByRole("button", { name: "Turn it back on" }));
    expect(mocks.clear).not.toHaveBeenCalled();
    await user.click(await screen.findByTestId("reenable-confirm"));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalled());
    expect(mocks.clear).toHaveBeenCalledWith({ id: "p5" });
    expect(mocks.sync.mock.calls[0]![0]).toEqual({ data: { itemId: "p5", force: true } });
  });
});

describe("Remove — the history stays", () => {
  it("opens a sheet that says so; only the confirm deletes", async () => {
    const user = userEvent.setup();
    mocks.del.mockImplementation((_v: unknown, o: { onSuccess: () => void }) => o.onSuccess());
    mount(<BanksView data={banks([OK])} now={NOW} />);
    await user.click(screen.getByTestId("remove-p1"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Your history stays");
    expect(mocks.del).not.toHaveBeenCalled();
    await user.click(within(dialog).getByTestId("remove-confirm"));
    expect(mocks.del.mock.calls[0]![0]).toEqual({ id: "p1" });
    expect((await screen.findByTestId("toast")).textContent).toContain("Sample Bank removed. Its history stays.");
  });

  it("a bank that needs reconnecting is offered Reconnect first", async () => {
    const user = userEvent.setup();
    mount(<BanksView data={banks([REAUTH])} now={NOW} />);
    await user.click(screen.getByTestId("remove-p2"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/starts the pull from scratch/);
    expect(within(dialog).getByRole("button", { name: "Reconnect instead" })).toBeTruthy();
  });

  it("a failed removal says so and leaves the bank", async () => {
    const user = userEvent.setup();
    mocks.del.mockImplementation((_v: unknown, o: { onError: (e: unknown) => void }) => o.onError({ status: 500 }));
    mount(<BanksView data={banks([OK])} now={NOW} />);
    await user.click(screen.getByTestId("remove-p1"));
    await user.click(await screen.findByTestId("remove-confirm"));
    expect((await screen.findByTestId("toast")).textContent).toContain("Couldn't remove that bank");
  });
});

describe("Connect a bank — link token, Plaid, exchange, debts, the backoff poll", () => {
  it("runs the whole flow and sends exactly what classic sent", async () => {
    const user = userEvent.setup();
    mocks.linkToken.mockResolvedValue({ linkToken: "link-sandbox-1", expiration: "x" });
    mocks.exchange.mockResolvedValue({ id: "new1", institutionName: "Sample Bank" });
    mocks.liabilities.mockResolvedValue([
      { id: "l1", accountId: "acc-card", itemId: "new1", name: "Sample Card", mask: "0300", subtype: "credit card", suggestedDebt: { name: "Sample Card", type: "credit" }, linkedDebt: null },
      { id: "l2", accountId: "acc-other", itemId: "other", name: "Elsewhere", suggestedDebt: { name: "Elsewhere", type: "credit" }, linkedDebt: null },
      { id: "l3", accountId: "acc-have", itemId: "new1", name: "Already", suggestedDebt: { name: "Already", type: "credit" }, linkedDebt: { id: "d1", name: "Already" } },
    ]);
    mocks.bulk.mockResolvedValue({ results: [{ plaidAccountId: "acc-card", status: "created", debtName: "Sample Card" }] });
    mocks.sync.mockResolvedValue(syncRes(2, { lastOccurredOn: "2026-10-06" }));
    mount(<BanksView data={banks([OK])} now={NOW} pollDelays={[0, 0]} />);

    await user.click(screen.getByTestId("connect-bank"));
    await waitFor(() => expect(mocks.plaidOpen).toHaveBeenCalled());
    expect(mocks.plaidCfg.token).toBe("link-sandbox-1");
    // OAuth banks come back through /plaid-oauth, which reads these two keys.
    expect(localStorage.getItem("h2:plaid:link_token")).toBe("link-sandbox-1");
    expect(localStorage.getItem("h2:plaid:return_to")).toBe(window.location.pathname + window.location.search);

    mocks.plaidCfg.onSuccess("public-sandbox-1", { institution: { institution_id: "ins_1", name: "Sample Bank" } });
    await waitFor(() => expect(mocks.exchange).toHaveBeenCalled());
    expect(mocks.exchange.mock.calls[0]![0]).toEqual({ data: { publicToken: "public-sandbox-1", institutionId: "ins_1", institutionName: "Sample Bank" } });
    expect(mocks.liabilities).toHaveBeenCalledWith({ refresh: true });
    expect(localStorage.getItem("h2:plaid:link_token")).toBeNull();

    // The "make these debts?" sheet: only the new bank's unlinked cards, names and masks, no amounts.
    const sheet = await screen.findByTestId("debts-sheet");
    expect(within(sheet).getAllByRole("checkbox")).toHaveLength(1);
    expect(sheet.textContent).toContain("Sample Card");
    expect(sheet.textContent).toContain("ending 0300");
    expect(sheet.textContent).not.toMatch(/\$/);
    await user.click(within(sheet).getByTestId("debts-add"));
    await waitFor(() => expect(mocks.bulk).toHaveBeenCalled());
    expect(mocks.bulk.mock.calls[0]![0]).toEqual({ data: { accounts: [{ plaidAccountId: "acc-card" }] } });

    // The first pull is the one billable call the flow makes on its own.
    await waitFor(() => expect(screen.getByTestId("post-link-progress").getAttribute("data-phase")).toBe("ready"));
    expect(mocks.sync.mock.calls[0]![0]).toEqual({ data: { itemId: "new1", force: true } });
    expect(screen.getByTestId("post-link-title").textContent).toBe("Ready. 2 added.");
    await user.click(screen.getByTestId("post-link-dismiss"));
    expect(screen.queryByTestId("post-link-progress")).toBeNull();
  });

  it("polls again while the bank is empty, then says it is still preparing", async () => {
    const user = userEvent.setup();
    mocks.linkToken.mockResolvedValue({ linkToken: "t", expiration: "x" });
    mocks.exchange.mockResolvedValue({ id: "new1" });
    mount(<BanksView data={banks([OK])} now={NOW} pollDelays={[0, 0, 0]} />);
    await user.click(screen.getByTestId("connect-bank"));
    await waitFor(() => expect(mocks.plaidOpen).toHaveBeenCalled());
    mocks.plaidCfg.onSuccess("p", { institution: { institution_id: "i", name: "Sample Bank" } });
    await waitFor(() => expect(screen.getByTestId("post-link-progress").getAttribute("data-phase")).toBe("still-preparing"));
    expect(mocks.sync).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("post-link-title").textContent).toBe("Still preparing");
  });

  it("a hard error stops the poll at once and names the problem", async () => {
    const user = userEvent.setup();
    mocks.linkToken.mockResolvedValue({ linkToken: "t", expiration: "x" });
    mocks.exchange.mockResolvedValue({ id: "new1" });
    mocks.sync.mockResolvedValue(syncRes(0, { error: "Plaid: the bank is down" }));
    mount(<BanksView data={banks([OK])} now={NOW} pollDelays={[0, 0, 0]} />);
    await user.click(screen.getByTestId("connect-bank"));
    await waitFor(() => expect(mocks.plaidOpen).toHaveBeenCalled());
    mocks.plaidCfg.onSuccess("p", { institution: { institution_id: "i", name: "Sample Bank" } });
    await waitFor(() => expect(screen.getByTestId("post-link-progress").getAttribute("data-phase")).toBe("error"));
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("post-link-detail").textContent).toBe("the bank is down");
  });

  it("closing Plaid without finishing clears the stored token and exchanges nothing", async () => {
    const user = userEvent.setup();
    mocks.linkToken.mockResolvedValue({ linkToken: "t", expiration: "x" });
    mount(<BanksView data={banks([OK])} now={NOW} />);
    await user.click(screen.getByTestId("connect-bank"));
    await waitFor(() => expect(mocks.plaidOpen).toHaveBeenCalled());
    mocks.plaidCfg.onExit();
    expect(localStorage.getItem("h2:plaid:link_token")).toBeNull();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("with a bank that needs reconnecting, asks first; 'link anyway' goes on", async () => {
    const user = userEvent.setup();
    mocks.linkToken.mockResolvedValue({ linkToken: "t", expiration: "x" });
    mount(<BanksView data={banks([OK, REAUTH])} now={NOW} />);
    await user.click(screen.getByTestId("connect-bank"));
    const guard = await screen.findByTestId("reauth-guard");
    expect(guard.textContent).toContain("Sample Credit Union");
    expect(mocks.linkToken).not.toHaveBeenCalled();
    await user.click(within(guard).getByTestId("guard-link-anyway"));
    await waitFor(() => expect(mocks.linkToken).toHaveBeenCalled());
  });
});

describe("Reconnect — Plaid's update mode", () => {
  it("asks for an update token for that item, then syncs it (no exchange)", async () => {
    const user = userEvent.setup();
    mocks.updateToken.mockResolvedValue({ linkToken: "update-1", expiration: "x" });
    mount(<BanksView data={banks([REAUTH])} now={NOW} />);
    await user.click(screen.getByTestId("reconnect-p2"));
    await waitFor(() => expect(mocks.plaidOpen).toHaveBeenCalled());
    expect(mocks.updateToken.mock.calls[0]![0]).toEqual({ data: { itemId: "p2" } });
    mocks.plaidCfg.onSuccess("public-update", { institution: { institution_id: "i", name: "Sample Credit Union" } });
    await waitFor(() => expect(mocks.sync).toHaveBeenCalled());
    expect(mocks.sync.mock.calls[0]![0]).toEqual({ data: { itemId: "p2", force: true } });
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect((await screen.findByTestId("toast")).textContent).toContain("Sample Credit Union reconnected");
  });

  it("a 409 'relink' answer falls back to a fresh link and exchanges it", async () => {
    const user = userEvent.setup();
    mocks.updateToken.mockRejectedValue({ status: 409, data: { action: "relink" } });
    mocks.linkToken.mockResolvedValue({ linkToken: "fresh-1", expiration: "x" });
    mocks.exchange.mockResolvedValue({ id: "new2" });
    mount(<BanksView data={banks([REAUTH])} now={NOW} pollDelays={[0]} />);
    await user.click(screen.getByTestId("reconnect-p2"));
    await waitFor(() => expect(mocks.plaidCfg?.token).toBe("fresh-1"));
    mocks.plaidCfg.onSuccess("public-fresh", { institution: { institution_id: "i", name: "Sample Credit Union" } });
    await waitFor(() => expect(mocks.exchange).toHaveBeenCalled());
  });

  it("the classic 'plaid:reconnect' event still starts a reconnect", async () => {
    mocks.updateToken.mockResolvedValue({ linkToken: "u2", expiration: "x" });
    mount(<BanksView data={banks([REAUTH])} now={NOW} />);
    window.dispatchEvent(new CustomEvent("plaid:reconnect", { detail: { itemId: "p2", institutionName: "Sample Credit Union" } }));
    await waitFor(() => expect(mocks.updateToken).toHaveBeenCalled());
  });
});

describe("Filing — the agent's handled list", () => {
  it("shows the saved preference and merges the change into what is already stored", async () => {
    const user = userEvent.setup();
    mocks.prefs.mockImplementation((_v: unknown, o: { onSuccess: () => void }) => o.onSuccess());
    mount(<BanksView data={banks([OK], { prefs: loaded({ autoCategorize: true, whatsNewSeen: "x" } as UiPreferences) })} now={NOW} />);
    const sw = screen.getByTestId("auto-file");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await user.click(sw);
    expect(mocks.prefs.mock.calls[0]![0]).toEqual({ data: { autoCategorize: false, whatsNewSeen: "x" } });
    expect((await screen.findByTestId("toast")).textContent).toBe("H2 will leave new charges for you to file.");
  });
});

// ---- Members ----------------------------------------------------------------

const ME: MeResponse = { userId: "u1", isOwner: true, displayName: "Sam (sample)", email: "sam@example.com" } as MeResponse;
const MEMBERS = [
  { id: "u1", displayName: "Sam (sample)", email: "sam@example.com", isOwner: true, lastSignInAt: Date.parse("2026-10-07T14:00:00Z") },
  { id: "u2", displayName: "Alex (sample)", email: "alex@example.com", isOwner: false, lastSignInAt: Date.parse("2026-10-05T14:00:00Z") },
] as Member[];
const INVITES = [
  { id: "i1", emailAddress: "jo@example.com", status: "pending", createdAt: Date.parse("2026-10-06T14:00:00Z"), updatedAt: 0 },
  { id: "i2", emailAddress: "alex@example.com", status: "accepted", createdAt: Date.parse("2026-09-20T14:00:00Z"), updatedAt: 0 },
  { id: "i3", emailAddress: "old@example.com", status: "revoked", createdAt: Date.parse("2026-09-10T14:00:00Z"), updatedAt: 0 },
] as Invitation[];
const people = (over: Partial<MembersData> = {}): MembersData => ({ me: loaded(ME), members: loaded(MEMBERS), invitations: loaded(INVITES), ...over });

describe("Members — owner", () => {
  it("lists members with their role; the owner and you carry no Remove", () => {
    mount(<MembersView data={people()} now={NOW} />);
    const rows = screen.getAllByTestId("member-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Sam (sample) (you)");
    expect(rows[0]!.textContent).toContain("Owner");
    expect(rows[1]!.textContent).toContain("Alex (sample)");
    expect(rows[1]!.textContent).toContain("Member");
    expect(rows[1]!.textContent).toContain("here 2 days ago");
    expect(within(rows[0]!).queryByRole("button")).toBeNull();
    expect(screen.getByTestId("remove-member-u2")).toBeTruthy();
    expect(screen.getByTestId("allowance-note").querySelector("a")!.getAttribute("href")).toBe("/plan");
  });

  it("Remove asks first and sends only on the confirm", async () => {
    const user = userEvent.setup();
    mocks.removeMember.mockImplementation((_v: unknown, o: { onSuccess: () => void }) => o.onSuccess());
    mount(<MembersView data={people()} now={NOW} />);
    await user.click(screen.getByTestId("remove-member-u2"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("invite them again");
    expect(mocks.removeMember).not.toHaveBeenCalled();
    await user.click(within(dialog).getByTestId("remove-member-confirm"));
    expect(mocks.removeMember.mock.calls[0]![0]).toEqual({ id: "u2" });
    expect((await screen.findByTestId("toast")).textContent).toBe("Member removed.");
  });

  it("invitations: status words, newest first; resend and cancel only while pending", () => {
    mount(<MembersView data={people()} now={NOW} />);
    const rows = screen.getAllByTestId("invite-row");
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["pending", "accepted", "revoked"]);
    expect(rows[0]!.textContent).toContain("Waiting");
    expect(rows[1]!.textContent).toContain("Joined");
    expect(rows[2]!.textContent).toContain("Cancelled");
    expect(screen.getByTestId("resend-i1")).toBeTruthy();
    expect(screen.getByTestId("cancel-i1")).toBeTruthy();
    expect(screen.queryByTestId("resend-i2")).toBeNull();
    expect(screen.queryByTestId("cancel-i3")).toBeNull();
  });

  it("invite: a bad email is refused in words; a good one sends the address", async () => {
    const user = userEvent.setup();
    mocks.invite.mockImplementation((_v: unknown, o: { onSuccess: () => void }) => o.onSuccess());
    mount(<MembersView data={people()} now={NOW} />);
    await user.type(screen.getByTestId("invite-email"), "not-an-email");
    await user.click(screen.getByTestId("invite-send"));
    expect(screen.getByRole("alert").textContent).toContain("Enter an email address");
    expect(mocks.invite).not.toHaveBeenCalled();
    await user.clear(screen.getByTestId("invite-email"));
    await user.type(screen.getByTestId("invite-email"), "  new@example.com ");
    await user.click(screen.getByTestId("invite-send"));
    expect(mocks.invite.mock.calls[0]![0]).toEqual({ data: { email: "new@example.com" } });
    expect((await screen.findByTestId("toast")).textContent).toBe("Invitation sent to new@example.com.");
    expect((screen.getByTestId("invite-email") as HTMLInputElement).value).toBe("");
  });

  it("resend and cancel send the invitation's id", async () => {
    const user = userEvent.setup();
    mocks.resend.mockImplementation((_v: unknown, o: { onSuccess: () => void }) => o.onSuccess());
    mocks.revoke.mockImplementation((_v: unknown, o: { onSuccess: () => void }) => o.onSuccess());
    mount(<MembersView data={people()} now={NOW} />);
    await user.click(screen.getByTestId("resend-i1"));
    expect(mocks.resend.mock.calls[0]![0]).toEqual({ id: "i1" });
    await user.click(screen.getByTestId("cancel-i1"));
    expect(mocks.revoke.mock.calls[0]![0]).toEqual({ id: "i1" });
  });

  it("the server's own words come back when an invitation fails", async () => {
    const user = userEvent.setup();
    mocks.invite.mockImplementation((_v: unknown, o: { onError: (e: unknown) => void }) => o.onError({ data: { error: "That person is already invited." } }));
    mount(<MembersView data={people()} now={NOW} />);
    await user.type(screen.getByTestId("invite-email"), "jo@example.com");
    await user.click(screen.getByTestId("invite-send"));
    expect((await screen.findByTestId("toast")).textContent).toBe("That person is already invited.");
  });
});

describe("Members — a member sees it read-only", () => {
  const memberMe = { userId: "u2", isOwner: false, displayName: "Alex (sample)", email: "alex@example.com" } as MeResponse;
  it("no list, no forms, no remove — only who you are and who manages this", () => {
    mount(<MembersView data={people({ me: loaded(memberMe), members: loaded<Member[]>(undefined), invitations: loaded<Invitation[]>(undefined) })} now={NOW} />);
    expect(screen.getByTestId("member-self").textContent).toBe("Alex (sample)");
    expect(screen.getByTestId("member-note").textContent).toContain("owner manages");
    expect(screen.queryByTestId("invite-email")).toBeNull();
    expect(screen.queryByTestId("member-list")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("allowance-note").querySelector("a")!.getAttribute("href")).toBe("/plan");
  });
  it("cold shows a skeleton, not the member view", () => {
    mount(<MembersView data={people({ me: loaded<MeResponse>(undefined) })} now={NOW} />);
    expect(screen.getByTestId("members-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("member-note")).toBeNull();
  });
});

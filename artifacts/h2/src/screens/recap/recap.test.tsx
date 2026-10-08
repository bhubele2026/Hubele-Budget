import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { HealthStatus, RecapDeliveryItem, RecapHistoryItem, RecapPreview, RecapSettings } from "@workspace/api-client-react";
import type { Read } from "@/data/todayData";

/**
 * ⭐ THE RECAP PAGE ASKS AND REPORTS; THE SERVER DECIDES.
 * Rendered on data it is handed, with every write mocked at the boundary:
 * consent comes before the code, the code is six digits, the switch waits for a
 * verified number, the 400/429 answers are shown in the server's own words, and
 * the history speaks in words. No real number appears anywhere (+1 555 01xx).
 */
type Fn = ReturnType<typeof vi.fn>;
const mocks = vi.hoisted(() => ({
  update: null as unknown as Fn,
  start: null as unknown as Fn,
  confirm: null as unknown as Fn,
  test: null as unknown as Fn,
  pause: null as unknown as Fn,
  unsub: null as unknown as Fn,
  preview: null as unknown as Fn,
}));
const hook = vi.hoisted(() => (key: keyof typeof mocks) => () => ({ mutate: mocks[key], isPending: false }));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useUpdateRecapSettings: hook("update"),
    useStartRecapVerification: hook("start"),
    useConfirmRecapVerification: hook("confirm"),
    useSendRecapTest: hook("test"),
    usePauseRecap: hook("pause"),
    useUnsubscribeRecap: hook("unsub"),
    usePreviewRecap: hook("preview"),
  };
});

import { RecapView, type RecapData } from "./Recap";
import { historyWords, testsLeft, toE164, maskedPhone, clockWords } from "./recapWords";

const NOW = new Date("2026-10-07T15:00:00Z");
const CONSENT = "By tapping Send code you agree to get one H2 text each morning. Reply STOP to opt out.";
const loaded = <T,>(data: T | undefined, over: Partial<Read<T>> = {}): Read<T> => ({
  data,
  state: data === undefined ? "cold" : "loaded",
  isFetching: false,
  refetch: vi.fn(),
  ...over,
});
const mount = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

const LIVE: RecapSettings["delivery"] = {
  mode: "live",
  providerConfigured: true,
  phoneVerified: false,
  scheduled: false,
  sendTimeLocal: "07:00",
  timezone: "America/Chicago",
  lastDelivery: null,
};
const PREVIEW: RecapSettings["delivery"] = { ...LIVE, mode: "preview", providerConfigured: false };
const NEW: RecapSettings = {
  delivery: LIVE,
  enabled: false,
  sendTimeLocal: "07:00",
  timezone: "America/Chicago",
  phoneLast4: null,
  verified: false,
  pausedUntil: null,
  skipWeekends: false,
  extraAlerts: false,
  consentedAt: null,
  optedOutAt: null,
  consentText: CONSENT,
  consentTextVersion: "v1",
};
const VERIFIED: RecapSettings = { ...NEW, phoneLast4: "0100", verified: true, consentedAt: "2026-10-05T14:00:00Z", delivery: { ...LIVE, phoneVerified: true } };
const hist = (id: string, forDate: string, text: string, over: Partial<RecapHistoryItem> = {}): RecapHistoryItem => ({
  id,
  forDate,
  text,
  source: "template",
  status: "sent",
  generatedAt: `${forDate}T12:00:00Z`,
  delivery: { status: "sent", provider: "twilio", createdAt: `${forDate}T12:30:00Z` },
  ...over,
});
const HEALTH = (sms: boolean, ai: boolean) => ({ status: "ok", version: "t", jobs: { mode: "off", started: false, failedLast24h: null, dlq: null }, ai: { enabled: ai, configured: ai, provider: "fake" }, sms: { provider: "console", configured: sms, mode: sms ? "live" : "preview" } }) as HealthStatus;
const data = (settings: RecapSettings | undefined, over: Partial<RecapData> = {}): RecapData => ({
  settings: loaded(settings),
  history: loaded<RecapHistoryItem[]>([]),
  deliveries: loaded<RecapDeliveryItem[]>([]),
  health: loaded(HEALTH(true, true)),
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(mocks) as Array<keyof typeof mocks>) mocks[k] = vi.fn();
});
afterEach(cleanup);

const ok = (key: keyof typeof mocks, value?: unknown) => mocks[key].mockImplementation((_v: unknown, o?: { onSuccess?: (r: unknown) => void }) => o?.onSuccess?.(value));
const fail = (key: keyof typeof mocks, error: unknown) => mocks[key].mockImplementation((_v: unknown, o?: { onError?: (e: unknown) => void }) => o?.onError?.(error));

describe("the page has no money figure", () => {
  it("a headline, words, and nothing shaped like a figure in the steps", () => {
    mount(<RecapView data={data(VERIFIED)} now={NOW} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Morning recap");
    for (const id of ["section-phone", "section-schedule", "section-preview"]) {
      expect(screen.getByTestId(id).textContent).not.toMatch(/\$\d/);
      expect(screen.getByTestId(id).querySelector("[data-testid^=figure]")).toBeNull();
    }
  });
  it("states: skeleton while cold, an error with Retry when it failed", async () => {
    const user = userEvent.setup();
    const { unmount } = mount(<RecapView data={data(undefined)} now={NOW} />);
    expect(screen.getByTestId("recap-skeleton")).toBeTruthy();
    unmount();
    const refetch = vi.fn();
    mount(<RecapView data={data(undefined, { settings: loaded<RecapSettings>(undefined, { state: "failed", refetch }) })} now={NOW} />);
    await user.click(within(screen.getByTestId("recap-error")).getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });
  it("the status ladder: preview mode is the first row, with its plain words", () => {
    mount(<RecapView data={data({ ...VERIFIED, delivery: { ...PREVIEW, phoneVerified: true, scheduled: true, lastDelivery: { status: "previewed", provider: "console", at: "2026-10-07T12:00:00Z" } } })} now={NOW} />);
    const rows = screen.getAllByTestId("ladder-row");
    expect(rows.map((r) => r.getAttribute("data-row"))).toEqual(["preview", "provider", "phone", "scheduled", "accepted", "delivered"]);
    expect(screen.getByTestId("preview-note").textContent).toBe("Texts are written to the server log. Nothing is sent until SMS is set up.");
    expect(within(rows[0]!).getByTestId("ladder-word").textContent).toBe("Yes");
    expect(rows[1]!.textContent).toContain("No");
    expect(rows[2]!.textContent).toContain("•••• 0100");
    expect(rows[3]!.textContent).toBe("Scheduled — 7:00 AM ChicagoYes");
    expect(within(rows[5]!).getByTestId("ladder-word").textContent).toBe("Preview — not sent");
    expect(screen.queryByText("Sent")).toBeNull();
  });
  it("the ladder in live mode has no preview row; a delivered text reads Yes; Off when not scheduled", () => {
    mount(<RecapView data={data({ ...VERIFIED, delivery: { ...LIVE, phoneVerified: true, scheduled: false, lastDelivery: { status: "delivered", provider: "twilio", at: "2026-10-07T12:00:00Z" } } })} now={NOW} />);
    const rows = screen.getAllByTestId("ladder-row");
    expect(rows.map((r) => r.getAttribute("data-row"))).toEqual(["provider", "phone", "scheduled", "accepted", "delivered"]);
    expect(screen.queryByTestId("preview-note")).toBeNull();
    expect(rows[2]!.textContent).toBe("ScheduledOff");
    expect(rows[3]!.textContent).toBe("Accepted by carrierYes");
    expect(rows[4]!.textContent).toBe("DeliveredYes");
  });
  it("a failed last text reads Failed", () => {
    mount(<RecapView data={data({ ...VERIFIED, delivery: { ...LIVE, phoneVerified: true, lastDelivery: { status: "undelivered", provider: "twilio", at: "2026-10-07T12:00:00Z" } } })} now={NOW} />);
    expect(screen.getAllByTestId("ladder-row").at(-1)!.textContent).toBe("FailedYes");
  });
  it("the 7:00 default is shown for a new member when scheduled", () => {
    mount(<RecapView data={data({ ...VERIFIED, enabled: true, delivery: { ...LIVE, phoneVerified: true, scheduled: true } })} now={NOW} />);
    expect(screen.getAllByTestId("ladder-row").find((r) => r.getAttribute("data-row") === "scheduled")!.textContent).toContain("7:00 AM Chicago");
    expect((screen.getByTestId("time-input") as HTMLInputElement).value).toBe("07:00");
  });
});

describe("Step 1 — phone", () => {
  it("shows the server's consent sentence ABOVE the checkbox", () => {
    mount(<RecapView data={data(NEW)} now={NOW} />);
    const text = screen.getByTestId("consent-text");
    expect(text.textContent).toBe(CONSENT);
    const box = screen.getByTestId("consent-check");
    expect(text.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Send code needs the consent and a US number; neither sends anything", async () => {
    const user = userEvent.setup();
    mount(<RecapView data={data(NEW)} now={NOW} />);
    await user.type(screen.getByTestId("phone-input"), "(555) 555-0100");
    await user.click(screen.getByTestId("send-code"));
    expect(screen.getByTestId("consent-error").textContent).toBe("Agree to the consent to get texts.");
    expect(mocks.start).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("consent-check"));
    await user.clear(screen.getByTestId("phone-input"));
    await user.type(screen.getByTestId("phone-input"), "555-0100");
    await user.click(screen.getByTestId("send-code"));
    expect(screen.getByRole("alert").textContent).toContain("10-digit US mobile number");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("sends the number as E.164 with consent: true, then asks for the code", async () => {
    const user = userEvent.setup();
    ok("start", { sent: true, expiresAt: "x", devCode: "123456" });
    mount(<RecapView data={data(NEW)} now={NOW} />);
    await user.type(screen.getByTestId("phone-input"), "(555) 555-0100");
    await user.click(screen.getByTestId("consent-check"));
    await user.click(screen.getByTestId("send-code"));
    expect(mocks.start.mock.calls[0]![0]).toEqual({ data: { phoneE164: "+15555550100", consent: true } });
    expect(screen.getByTestId("code-form")).toBeTruthy();
    expect(screen.getByTestId("dev-code").textContent).toBe("Preview mode: the code is 123456.");
  });

  it("the server's refusal is shown in its own words", async () => {
    const user = userEvent.setup();
    fail("start", { data: { error: "Too many codes requested today. Try again tomorrow." } });
    mount(<RecapView data={data(NEW)} now={NOW} />);
    await user.type(screen.getByTestId("phone-input"), "5555550100");
    await user.click(screen.getByTestId("consent-check"));
    await user.click(screen.getByTestId("send-code"));
    expect(screen.getByTestId("phone-error").textContent).toBe("Too many codes requested today. Try again tomorrow.");
  });

  it("the code is six digits: five is refused without a call; six is confirmed", async () => {
    const user = userEvent.setup();
    ok("start", { sent: true, expiresAt: "x" });
    mount(<RecapView data={data(NEW)} now={NOW} />);
    await user.type(screen.getByTestId("phone-input"), "5555550100");
    await user.click(screen.getByTestId("consent-check"));
    await user.click(screen.getByTestId("send-code"));
    await user.type(screen.getByTestId("code-input"), "12a345");
    expect((screen.getByTestId("code-input") as HTMLInputElement).value).toBe("12345");
    await user.click(screen.getByTestId("confirm-code"));
    expect(screen.getByRole("alert").textContent).toBe("Enter the 6-digit code.");
    expect(mocks.confirm).not.toHaveBeenCalled();
    fail("confirm", { data: { error: "That code is not right. 4 tries left." } });
    await user.type(screen.getByTestId("code-input"), "6");
    await user.click(screen.getByTestId("confirm-code"));
    expect(mocks.confirm.mock.calls[0]![0]).toEqual({ data: { code: "123456" } });
    expect(screen.getByRole("alert").textContent).toBe("That code is not right. 4 tries left.");
  });

  it("a verified number is masked, with Change", async () => {
    const user = userEvent.setup();
    mount(<RecapView data={data(VERIFIED)} now={NOW} />);
    expect(screen.getByTestId("phone-mask").textContent).toBe("•••• 0100");
    expect(screen.queryByTestId("phone-form")).toBeNull();
    await user.click(screen.getByTestId("phone-change"));
    expect(screen.getByTestId("phone-form")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep my number" }));
    expect(screen.getByTestId("phone-mask").textContent).toBe("•••• 0100");
  });

  it("an opt-out by text is explained", () => {
    mount(<RecapView data={data({ ...VERIFIED, optedOutAt: "2026-10-06T00:00:00Z" })} now={NOW} />);
    expect(screen.getByTestId("opted-out").textContent).toContain("You opted out by text");
  });
});

describe("Step 2 — schedule", () => {
  it("Enabled waits for a verified, consented number", () => {
    const { unmount } = mount(<RecapView data={data(NEW)} now={NOW} />);
    expect((screen.getByTestId("enabled") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("section-schedule").textContent).toContain("Verify your number and agree to the consent first.");
    unmount();
    mount(<RecapView data={data({ ...VERIFIED, optedOutAt: "2026-10-06T00:00:00Z" })} now={NOW} />);
    expect((screen.getByTestId("enabled") as HTMLButtonElement).disabled).toBe(true);
  });

  it("turns on with exactly { enabled: true }; a 400 shows the server's message", async () => {
    const user = userEvent.setup();
    mount(<RecapView data={data(VERIFIED)} now={NOW} />);
    ok("update", { ...VERIFIED, enabled: true });
    await user.click(screen.getByTestId("enabled"));
    expect(mocks.update.mock.calls[0]![0]).toEqual({ data: { enabled: true } });
    fail("update", { status: 400, data: { error: "Verify your phone number before turning the recap on.", code: "not_verified" } });
    await user.click(screen.getByTestId("enabled"));
    expect(screen.getByTestId("enable-error").textContent).toBe("Verify your phone number before turning the recap on.");
  });

  it("defaults to 7:00 Chicago; Save sends the time, zone and both switches", async () => {
    const user = userEvent.setup();
    ok("update", VERIFIED);
    mount(<RecapView data={data(VERIFIED)} now={NOW} />);
    expect((screen.getByTestId("time-input") as HTMLInputElement).value).toBe("07:00");
    expect((screen.getByTestId("tz-select") as HTMLSelectElement).value).toBe("America/Chicago");
    expect((screen.getByTestId("save-schedule") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("time-input"), { target: { value: "08:30" } });
    await user.selectOptions(screen.getByTestId("tz-select"), "America/New_York");
    await user.click(screen.getByTestId("skip-weekends"));
    await user.click(screen.getByTestId("extra-alerts"));
    await user.click(screen.getByTestId("save-schedule"));
    expect(mocks.update.mock.calls[0]![0]).toEqual({
      data: { sendTimeLocal: "08:30", timezone: "America/New_York", skipWeekends: true, extraAlerts: true },
    });
  });

  it("the five listed zones, and Other takes free text", async () => {
    const user = userEvent.setup();
    ok("update", VERIFIED);
    mount(<RecapView data={data(VERIFIED)} now={NOW} />);
    const options = within(screen.getByTestId("tz-select")).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(["America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles", "America/Phoenix", "__other"]);
    await user.selectOptions(screen.getByTestId("tz-select"), "__other");
    const other = screen.getByTestId("tz-other");
    await user.clear(other);
    await user.type(other, "Europe/London");
    await user.click(screen.getByTestId("save-schedule"));
    expect(mocks.update.mock.calls[0]![0].data.timezone).toBe("Europe/London");
  });

  it("a zone outside the list opens on Other", () => {
    mount(<RecapView data={data({ ...VERIFIED, timezone: "Europe/London" })} now={NOW} />);
    expect((screen.getByTestId("tz-select") as HTMLSelectElement).value).toBe("__other");
    expect((screen.getByTestId("tz-other") as HTMLInputElement).value).toBe("Europe/London");
  });
});

describe("Step 3 — preview, test text, pause, unsubscribe", () => {
  const PREVIEW = (model: RecapPreview["model"]): RecapPreview => ({ model, template: { text: "Good morning. A quiet day." }, facts: {} });

  it("renders the template and the model draft, with Demo when the response says so", async () => {
    const user = userEvent.setup();
    ok("preview", PREVIEW({ text: "Morning! Easy day ahead.", source: "model", demo: true }));
    mount(<RecapView data={data(VERIFIED)} now={NOW} />);
    await user.click(screen.getByTestId("preview-run"));
    expect(mocks.preview.mock.calls[0]![0]).toEqual({ data: {} });
    expect(screen.getByTestId("preview-template-text").textContent).toBe("Good morning. A quiet day.");
    expect(screen.getByTestId("preview-model-text").textContent).toBe("Morning! Easy day ahead.");
    expect(screen.getByTestId("demo-label").textContent).toBe("Demo");
  });

  it("a live model draft carries no Demo label", async () => {
    const user = userEvent.setup();
    ok("preview", PREVIEW({ text: "Live words.", source: "model", demo: false }));
    mount(<RecapView data={data(VERIFIED)} now={NOW} />);
    await user.click(screen.getByTestId("preview-run"));
    expect(screen.getByTestId("preview-model-text").textContent).toBe("Live words.");
    expect(screen.queryByTestId("demo-label")).toBeNull();
  });

  it("with no model draft: the AI note only when AI is off", async () => {
    const user = userEvent.setup();
    ok("preview", PREVIEW(null));
    const { unmount } = mount(<RecapView data={data(VERIFIED, { health: loaded(HEALTH(true, false)) })} now={NOW} />);
    await user.click(screen.getByTestId("preview-run"));
    expect(screen.getByTestId("ai-off-note").textContent).toBe("A live model draft needs AI turned on.");
    expect(screen.getByTestId("preview-template-text")).toBeTruthy();
    unmount();
    mount(<RecapView data={data(VERIFIED)} now={NOW} />);
    await user.click(screen.getByTestId("preview-run"));
    expect(screen.queryByTestId("ai-off-note")).toBeNull();
  });

  it("a preview that fails says so", async () => {
    const user = userEvent.setup();
    fail("preview", { status: 500 });
    mount(<RecapView data={data(VERIFIED)} now={NOW} />);
    await user.click(screen.getByTestId("preview-run"));
    expect(screen.getByTestId("preview-error").textContent).toContain("Couldn't draft a preview");
  });

  it("test text: needs a verified number; shows the count left; a 429 is shown as the server wrote it", async () => {
    const user = userEvent.setup();
    const tests: RecapDeliveryItem[] = [
      { id: "d1", kind: "test", forDate: null, status: "delivered", provider: "twilio", createdAt: "2026-10-07T13:00:00Z" },
      { id: "d2", kind: "scheduled", forDate: "2026-10-07", status: "delivered", provider: "twilio", createdAt: "2026-10-07T12:00:00Z" },
      { id: "d3", kind: "test", forDate: null, status: "delivered", provider: "twilio", createdAt: "2026-10-05T13:00:00Z" },
    ];
    const { unmount } = mount(<RecapView data={data(NEW)} now={NOW} />);
    expect((screen.getByTestId("test-send") as HTMLButtonElement).disabled).toBe(true);
    unmount();
    mount(<RecapView data={data(VERIFIED, { deliveries: loaded(tests) })} now={NOW} />);
    expect(screen.getByTestId("tests-left").textContent).toBe("2 left today");
    ok("test", { status: "sent", mode: "live", deliveryId: "x", text: null });
    await user.click(screen.getByTestId("test-send"));
    expect(mocks.test).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("test-note").textContent).toBe("Test text sent.");
    expect(screen.queryByTestId("test-shown")).toBeNull();
    ok("test", { status: "previewed", mode: "preview", deliveryId: "y", text: "H2 test: your morning recap will arrive at 07:00 America/Chicago." });
    await user.click(screen.getByTestId("test-send"));
    expect(screen.getByTestId("test-note").textContent).toBe("Preview shown. No text was sent.");
    expect(screen.getByTestId("test-shown").textContent).toContain("H2 test:");
    fail("test", { status: 429, data: { error: "That is 3 test texts today. Try again tomorrow.", code: "test_limit" } });
    await user.click(screen.getByTestId("test-send"));
    expect(screen.getByTestId("test-note").textContent).toBe("That is 3 test texts today. Try again tomorrow.");
  });

  it("no tests left disables the button", () => {
    const used: RecapDeliveryItem[] = [1, 2, 3].map((n) => ({ id: `d${n}`, kind: "test", forDate: null, status: "sent", provider: "twilio", createdAt: "2026-10-07T13:00:00Z" }));
    mount(<RecapView data={data(VERIFIED, { deliveries: loaded(used) })} now={NOW} />);
    expect(screen.getByTestId("tests-left").textContent).toBe("0 left today");
    expect((screen.getByTestId("test-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("pause until a date sends an instant; a paused recap shows Resume, which sends null", async () => {
    const user = userEvent.setup();
    ok("pause", { ...VERIFIED, pausedUntil: "2026-10-20T05:00:00.000Z" });
    const { unmount } = mount(<RecapView data={data(VERIFIED)} now={NOW} />);
    expect((screen.getByTestId("pause-go") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("pause-date"), { target: { value: "2026-10-20" } });
    await user.click(screen.getByTestId("pause-go"));
    const sent = mocks.pause.mock.calls[0]![0].data.until as string;
    expect(new Date(sent).getTime()).toBe(new Date("2026-10-20T00:00:00").getTime());
    unmount();
    mount(<RecapView data={data({ ...VERIFIED, pausedUntil: "2026-10-20T17:00:00Z" })} now={NOW} />);
    expect(screen.getByTestId("paused-line").textContent).toBe("Paused until Oct 20.");
    await user.click(screen.getByTestId("resume"));
    expect(mocks.pause.mock.calls[1]![0]).toEqual({ data: { until: null } });
  });

  it("a pause already in the past is not shown as paused", () => {
    mount(<RecapView data={data({ ...VERIFIED, pausedUntil: "2026-10-01T00:00:00Z" })} now={NOW} />);
    expect(screen.queryByTestId("paused-line")).toBeNull();
  });

  it("Unsubscribe asks first and sends only on the confirm", async () => {
    const user = userEvent.setup();
    ok("unsub", { ...VERIFIED, enabled: false, optedOutAt: "2026-10-07T15:00:00Z" });
    mount(<RecapView data={data(VERIFIED)} now={NOW} />);
    await user.click(screen.getByTestId("unsubscribe"));
    const sheet = await screen.findByTestId("unsubscribe-sheet");
    expect(screen.getByRole("dialog").textContent).toContain("verify your number once more");
    expect(mocks.unsub).not.toHaveBeenCalled();
    await user.click(within(sheet).getByTestId("unsubscribe-confirm"));
    expect(mocks.unsub).toHaveBeenCalledTimes(1);
  });
});

describe("History — in words", () => {
  const rows: RecapHistoryItem[] = [
    hist("h1", "2026-10-07", "Model words for the 7th.", { source: "model", delivery: { status: "delivered", provider: "twilio", createdAt: "2026-10-07T12:30:00Z" } }),
    hist("h2", "2026-10-06", "Template words for the 6th."),
    hist("h3", "2026-10-05", "Never arrived.", { delivery: { status: "undelivered", provider: "twilio", createdAt: "2026-10-05T12:30:00Z" } }),
    hist("h4", "2026-10-04", "Could not be sent.", { status: "failed", delivery: null }),
    hist("h5", "2026-10-03", "Skipped on a weekend.", { status: "skipped", delivery: null }),
  ];
  it("a console delivery is never called Sent", () => {
    const previewed = hist("p1", "2026-10-07", "Never left the server.", { status: "sent", delivery: { status: "sent", provider: "console", createdAt: "2026-10-07T12:30:00Z" } });
    const mapped = hist("p2", "2026-10-06", "Mapped by the server.", { status: "previewed", delivery: { status: "previewed", provider: "console", createdAt: "2026-10-06T12:30:00Z" } });
    mount(<RecapView data={data(VERIFIED, { history: loaded([previewed, mapped]) })} now={NOW} />);
    const list = screen.getAllByTestId("history-row");
    expect(list.map((r) => r.getAttribute("data-status"))).toEqual(["previewed", "previewed"]);
    for (const r of list) expect(within(r).getByTestId("history-status").textContent).toBe("Preview — not sent");
    expect(screen.queryByText("Sent")).toBeNull();
  });
  it("date, status word, source word; the text sits in a closed Disclosure; failures say why", () => {
    mount(<RecapView data={data(VERIFIED, { history: loaded(rows) })} now={NOW} />);
    const list = screen.getAllByTestId("history-row");
    expect(list.map((r) => r.getAttribute("data-status"))).toEqual(["delivered", "sent", "failed", "failed", "skipped"]);
    expect(within(list[0]!).getByTestId("history-status").textContent).toBe("Delivered");
    expect(list[0]!.textContent).toContain("Oct 7");
    expect(within(list[0]!).getByTestId("history-source").textContent).toBe("Written by the model");
    expect(within(list[1]!).getByTestId("history-source").textContent).toBe("Template");
    const details = list[0]!.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Model words for the 7th.");
    expect(within(list[2]!).getByTestId("history-problem").textContent).toBe("The carrier did not deliver it.");
    expect(within(list[3]!).getByTestId("history-problem").textContent).toBe("It could not be sent.");
    expect(within(list[4]!).getByTestId("history-status").textContent).toBe("Skipped");
    expect(within(list[0]!).queryByTestId("history-problem")).toBeNull();
  });
  it("empty and failed", () => {
    const refetch = vi.fn();
    const { unmount } = mount(<RecapView data={data(VERIFIED)} now={NOW} />);
    expect(screen.getByTestId("history-empty").textContent).toContain("No recap has been drafted yet");
    unmount();
    mount(<RecapView data={data(VERIFIED, { history: loaded<RecapHistoryItem[]>(undefined, { state: "failed", refetch }) })} now={NOW} />);
    expect(screen.getByText("Couldn't load the history.")).toBeTruthy();
  });
});

describe("recapWords", () => {
  it("US numbers become E.164; anything else is null", () => {
    expect(toE164("(555) 555-0100")).toBe("+15555550100");
    expect(toE164("1 555 555 0100")).toBe("+15555550100");
    expect(toE164("+1 (555) 555-0100")).toBe("+15555550100");
    expect(toE164("555-0100")).toBeNull();
    expect(toE164("+44 20 7946 0958")).toBeNull();
  });
  it("mask, clock, tests left, history words", () => {
    expect(maskedPhone("0100")).toBe("•••• 0100");
    expect(clockWords("07:00")).toBe("7:00 AM");
    expect(clockWords("00:15")).toBe("12:15 AM");
    expect(clockWords("13:05")).toBe("1:05 PM");
    expect(testsLeft(undefined)).toBeNull();
    expect(historyWords(hist("x", "2026-10-07", "t", { status: "drafted", delivery: null })).status).toBe("drafted");
  });
});

import { Router, type IRouter, type Request, type Response } from "express";
import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { addDaysISO, localDateInZone } from "@workspace/avalanche-core";
import {
  db,
  householdMembersTable,
  recapsTable,
  recapDeliveriesTable,
  recapSettingsTable,
  recapVerificationsTable,
  type RecapSettings,
} from "@workspace/db";
import {
  ConfirmRecapVerificationBody,
  ConfirmRecapVerificationResponse,
  GenerateRecapNowBody,
  GenerateRecapNowResponse,
  GetRecapSettingsResponse,
  ListRecapDeliveriesQueryParams,
  ListRecapDeliveriesResponse,
  ListRecapHistoryQueryParams,
  ListRecapHistoryResponse,
  PauseRecapBody,
  PauseRecapResponse,
  PreviewRecapBody,
  PreviewRecapResponse,
  SendRecapTestResponse,
  StartRecapVerificationBody,
  StartRecapVerificationResponse,
  UnsubscribeRecapResponse,
  UpdateRecapSettingsBody,
  UpdateRecapSettingsResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getSmsProvider } from "../lib/sms";
import { last4, normalizeUsPhone } from "../lib/sms/phone";
import { sendSms } from "../lib/sms/send";
import { sendRecapDelivery } from "../recap/deliver";
import { generateRecap } from "../recap/generate";
import { CONSENT_TEXT, CONSENT_TEXT_VERSION, testBody, verificationBody } from "../recap/messages";

// (AI-4b) The member's own recap-text settings, phone verification and
// delivery history. Everything is scoped by (household, user): a member only
// ever reads or changes their own row. No endpoint returns a full phone
// number — only its last four digits.

const router: IRouter = Router();

export const VERIFY_TTL_MS = 10 * 60_000;
export const VERIFY_STARTS_PER_DAY = 3;
export const VERIFY_MAX_ATTEMPTS = 5;
export const TEST_SENDS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60_000;
const MAX_PAUSE_MS = 366 * DAY_MS;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// One request at a time per (action, member): the daily limits are count-then-
// insert, so two simultaneous requests must not both pass the count. One
// instance serves the app, so an in-process queue is enough.
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function fail(res: Response, status: number, error: string, code?: string): void {
  res.status(status).json({ error, ...(code ? { code } : {}) });
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function view(s: RecapSettings) {
  return {
    enabled: s.enabled,
    sendTimeLocal: s.sendTimeLocal,
    timezone: s.timezone,
    phoneLast4: last4(s.phoneE164),
    verified: s.verifiedAt !== null && s.phoneE164 !== null,
    pausedUntil: iso(s.pausedUntil),
    skipWeekends: s.skipWeekends,
    extraAlerts: s.extraAlerts,
    consentedAt: iso(s.consentedAt),
    optedOutAt: iso(s.optedOutAt),
    consentText: CONSENT_TEXT,
    consentTextVersion: CONSENT_TEXT_VERSION,
  };
}

function who(req: Request): { userId: string; householdId: string } {
  return { userId: req.actualUserId!, householdId: req.householdId! };
}

async function ensureSettings(householdId: string, userId: string): Promise<RecapSettings> {
  await db.insert(recapSettingsTable).values({ householdId, userId }).onConflictDoNothing();
  const [row] = await db
    .select()
    .from(recapSettingsTable)
    .where(and(eq(recapSettingsTable.householdId, householdId), eq(recapSettingsTable.userId, userId)));
  return row!;
}

async function updateSettings(s: RecapSettings, set: Partial<typeof recapSettingsTable.$inferInsert>): Promise<RecapSettings> {
  const [row] = await db
    .update(recapSettingsTable)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(recapSettingsTable.id, s.id))
    .returning();
  return row!;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function hashCode(verificationId: string, code: string): string {
  return createHash("sha256").update(`${verificationId}:${code}`).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

router.get("/recap/settings", requireAuth, async (req, res): Promise<void> => {
  const { userId, householdId } = who(req);
  res.json(GetRecapSettingsResponse.parse(view(await ensureSettings(householdId, userId))));
});

router.put("/recap/settings", requireAuth, async (req, res): Promise<void> => {
  const { userId, householdId } = who(req);
  const parsed = UpdateRecapSettingsBody.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "Those settings are not valid.", "invalid_body");
  const b = parsed.data;
  if (b.timezone !== undefined && !validTimezone(b.timezone)) {
    return fail(res, 400, "That time zone is not recognised.", "bad_timezone");
  }
  if (b.sendTimeLocal !== undefined && !TIME_RE.test(b.sendTimeLocal)) {
    return fail(res, 400, "Send time must be HH:MM, 24-hour.", "bad_time");
  }
  const current = await ensureSettings(householdId, userId);
  if (b.enabled === true) {
    if (current.optedOutAt) {
      return fail(res, 400, "You opted out by text. Verify your number again to turn the recap back on.", "opted_out");
    }
    if (!current.verifiedAt || !current.phoneE164) {
      return fail(res, 400, "Verify your phone number before turning the recap on.", "not_verified");
    }
    if (!current.consentedAt) {
      return fail(res, 400, "Agree to the text-message consent before turning the recap on.", "no_consent");
    }
  }
  const row = await updateSettings(current, {
    ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
    ...(b.sendTimeLocal !== undefined ? { sendTimeLocal: b.sendTimeLocal } : {}),
    ...(b.timezone !== undefined ? { timezone: b.timezone } : {}),
    ...(b.skipWeekends !== undefined ? { skipWeekends: b.skipWeekends } : {}),
    ...(b.extraAlerts !== undefined ? { extraAlerts: b.extraAlerts } : {}),
  });
  res.json(UpdateRecapSettingsResponse.parse(view(row)));
});

router.post("/recap/verify/start", requireAuth, async (req, res): Promise<void> => {
  const { userId, householdId } = who(req);
  const parsed = StartRecapVerificationBody.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "Enter a phone number and agree to the consent.", "invalid_body");
  if (parsed.data.consent !== true) return fail(res, 400, "You need to agree to the consent to get texts.", "consent_required");
  const phone = normalizeUsPhone(parsed.data.phoneE164);
  if (!phone) return fail(res, 400, "Enter a US mobile number, such as (555) 555-0100.", "bad_phone");

  await withLock(`verify-start:${userId}`, async () => {
    const settings = await ensureSettings(householdId, userId);
    const since = new Date(Date.now() - DAY_MS);
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(recapVerificationsTable)
      .where(and(eq(recapVerificationsTable.userId, userId), gte(recapVerificationsTable.createdAt, since)));
    if (n >= VERIFY_STARTS_PER_DAY) {
      return fail(res, 429, "Too many codes requested today. Try again tomorrow.", "too_many_starts");
    }

    const now = new Date();
    // Consent is recorded at the moment the member asks for the code.
    await updateSettings(settings, { consentTextVersion: CONSENT_TEXT_VERSION, consentedAt: now });
    // Only the newest code is ever live.
    await db
      .update(recapVerificationsTable)
      .set({ consumedAt: now })
      .where(and(eq(recapVerificationsTable.userId, userId), isNull(recapVerificationsTable.consumedAt)));

    const id = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(now.getTime() + VERIFY_TTL_MS);
    await db.insert(recapVerificationsTable).values({
      id,
      householdId,
      userId,
      phoneE164: phone,
      codeHash: hashCode(id, code),
      expiresAt,
    });

    const sent = await sendSms({
      householdId,
      userId,
      kind: "verification",
      to: phone,
      body: verificationBody(code),
      idempotencyKey: `verify:${id}`,
    });
    if (sent.outcome !== "sent") {
      return fail(res, 502, "The text could not be sent. Try again in a few minutes.", "send_failed");
    }
    const showDevCode = process.env.NODE_ENV !== "production" && getSmsProvider().name === "console";
    res.json(
      StartRecapVerificationResponse.parse({
        sent: true,
        expiresAt: expiresAt.toISOString(),
        ...(showDevCode ? { devCode: code } : {}),
      }),
    );
  });
});

router.post("/recap/verify/confirm", requireAuth, async (req, res): Promise<void> => {
  const { userId, householdId } = who(req);
  const parsed = ConfirmRecapVerificationBody.safeParse(req.body ?? {});
  const code = parsed.success ? parsed.data.code.trim() : "";
  if (!/^\d{6}$/.test(code)) return fail(res, 400, "Enter the 6-digit code.", "bad_code");

  await withLock(`verify-confirm:${userId}`, async () => {
    const [v] = await db
      .select()
      .from(recapVerificationsTable)
      .where(and(eq(recapVerificationsTable.userId, userId), isNull(recapVerificationsTable.consumedAt)))
      .orderBy(desc(recapVerificationsTable.createdAt))
      .limit(1);
    if (!v || v.expiresAt.getTime() <= Date.now()) {
      return fail(res, 400, "That code has expired. Ask for a new one.", "expired");
    }
    // Count the try first, atomically: a locked code can never be guessed again.
    const [tried] = await db
      .update(recapVerificationsTable)
      .set({ attempts: sql`${recapVerificationsTable.attempts} + 1` })
      .where(
        and(
          eq(recapVerificationsTable.id, v.id),
          isNull(recapVerificationsTable.consumedAt),
          sql`${recapVerificationsTable.attempts} < ${VERIFY_MAX_ATTEMPTS}`,
        ),
      )
      .returning({ attempts: recapVerificationsTable.attempts });
    if (!tried) return fail(res, 429, "Too many wrong codes. Ask for a new one.", "locked");
    if (!sameHash(hashCode(v.id, code), v.codeHash)) {
      return fail(res, 400, `That code is not right. ${VERIFY_MAX_ATTEMPTS - tried.attempts} tries left.`, "wrong_code");
    }
    const [consumed] = await db
      .update(recapVerificationsTable)
      .set({ consumedAt: new Date() })
      .where(and(eq(recapVerificationsTable.id, v.id), isNull(recapVerificationsTable.consumedAt)))
      .returning({ id: recapVerificationsTable.id });
    if (!consumed) return fail(res, 400, "That code was already used. Ask for a new one.", "expired");

    const settings = await ensureSettings(householdId, userId);
    // A fresh, confirmed verification is fresh consent: it also lifts an earlier opt-out.
    const row = await updateSettings(settings, { phoneE164: v.phoneE164, verifiedAt: new Date(), optedOutAt: null });
    res.json(ConfirmRecapVerificationResponse.parse(view(row)));
  });
});

router.post("/recap/test-send", requireAuth, async (req, res): Promise<void> => {
  const { userId, householdId } = who(req);
  await withLock(`test-send:${userId}`, async () => {
    const settings = await ensureSettings(householdId, userId);
    if (settings.optedOutAt) return fail(res, 400, "You opted out by text. Verify your number again first.", "opted_out");
    if (!settings.verifiedAt || !settings.phoneE164) {
      return fail(res, 400, "Verify your phone number first.", "not_verified");
    }
    const since = new Date(Date.now() - DAY_MS);
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(recapDeliveriesTable)
      .where(
        and(
          eq(recapDeliveriesTable.userId, userId),
          eq(recapDeliveriesTable.kind, "test"),
          gte(recapDeliveriesTable.createdAt, since),
        ),
      );
    if (n >= TEST_SENDS_PER_DAY) return fail(res, 429, "That is 3 test texts today. Try again tomorrow.", "test_limit");

    const result = await sendRecapDelivery({
      userId,
      householdId,
      kind: "test",
      body: testBody(settings.sendTimeLocal, settings.timezone),
    });
    if (result.outcome === "blocked") return fail(res, 400, "Texts are not available for this number.", result.blocked);
    if (result.outcome !== "sent") return fail(res, 502, "The text could not be sent. Try again in a few minutes.", "send_failed");
    res.json(SendRecapTestResponse.parse({ status: "sent", deliveryId: result.deliveryId }));
  });
});

router.post("/recap/pause", requireAuth, async (req, res): Promise<void> => {
  const { userId, householdId } = who(req);
  const parsed = PauseRecapBody.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "Say when to pause until, or null to resume.", "invalid_body");
  let until: Date | null = null;
  if (parsed.data.until !== null) {
    until = new Date(parsed.data.until);
    if (Number.isNaN(until.getTime())) return fail(res, 400, "That is not a valid date and time.", "bad_until");
    if (until.getTime() - Date.now() > MAX_PAUSE_MS) return fail(res, 400, "Pause for up to a year.", "bad_until");
    if (until.getTime() <= Date.now()) until = null;
  }
  const current = await ensureSettings(householdId, userId);
  res.json(PauseRecapResponse.parse(view(await updateSettings(current, { pausedUntil: until }))));
});

router.post("/recap/unsubscribe", requireAuth, async (req, res): Promise<void> => {
  const { userId, householdId } = who(req);
  const current = await ensureSettings(householdId, userId);
  const row = await updateSettings(current, { optedOutAt: new Date(), enabled: false });
  res.json(UnsubscribeRecapResponse.parse(view(row)));
});

router.get("/recap/deliveries", requireAuth, async (req, res): Promise<void> => {
  const { userId, householdId } = who(req);
  const q = ListRecapDeliveriesQueryParams.safeParse(req.query);
  if (!q.success) return fail(res, 400, "limit must be between 1 and 30.", "bad_limit");
  const rows = await db
    .select({
      id: recapDeliveriesTable.id,
      kind: recapDeliveriesTable.kind,
      forDate: recapDeliveriesTable.forDate,
      status: recapDeliveriesTable.status,
      createdAt: recapDeliveriesTable.createdAt,
    })
    .from(recapDeliveriesTable)
    .where(and(eq(recapDeliveriesTable.householdId, householdId), eq(recapDeliveriesTable.userId, userId)))
    .orderBy(desc(recapDeliveriesTable.createdAt))
    .limit(q.data.limit ?? 30);
  res.json(
    ListRecapDeliveriesResponse.parse(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))),
  );
});

// ── (AI-4a) Preview, history, generate-now ─────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS_BACK = 30;

function validDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The recap date to use: the one asked for, or today in the member's zone. */
function resolveForDate(asked: string | undefined, timezone: string): { forDate: string } | { error: string } {
  const today = localDateInZone(new Date(), timezone);
  if (asked === undefined) return { forDate: today };
  if (!validDate(asked)) return { error: "forDate must be a real date, YYYY-MM-DD." };
  if (asked > addDaysISO(today, 1) || asked < addDaysISO(today, -MAX_DAYS_BACK)) {
    return { error: `forDate must be within ${MAX_DAYS_BACK} days back and one day ahead.` };
  }
  return { forDate: asked };
}

router.post("/recap/preview", requireAuth, async (req, res): Promise<void> => {
  const { userId, householdId } = who(req);
  const parsed = PreviewRecapBody.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "Those settings are not valid.", "invalid_body");
  const settings = await ensureSettings(householdId, userId);
  const when = resolveForDate(parsed.data.forDate, settings.timezone);
  if ("error" in when) return fail(res, 400, when.error, "bad_date");
  const out = await generateRecap(householdId, userId, when.forDate, {
    preview: true,
    ownerUserId: req.householdOwnerId!,
  });
  if (!out.preview) return fail(res, 500, "Could not draft the recap.", "preview_failed");
  res.json(PreviewRecapResponse.parse({ model: out.model, template: out.template, facts: out.facts }));
});

function historyItem(r: typeof recapsTable.$inferSelect, d: { status: string; createdAt: Date } | null) {
  return {
    id: r.id,
    forDate: r.forDate,
    text: r.text,
    source: r.source,
    status: r.status,
    generatedAt: r.generatedAt.toISOString(),
    delivery: d ? { status: d.status, createdAt: d.createdAt.toISOString() } : null,
  };
}

router.get("/recap/history", requireAuth, async (req, res): Promise<void> => {
  const { userId, householdId } = who(req);
  const q = ListRecapHistoryQueryParams.safeParse(req.query);
  if (!q.success) return fail(res, 400, "limit must be between 1 and 30.", "bad_limit");
  const rows = await db
    .select({
      recap: recapsTable,
      deliveryStatus: recapDeliveriesTable.status,
      deliveryCreatedAt: recapDeliveriesTable.createdAt,
    })
    .from(recapsTable)
    .leftJoin(
      recapDeliveriesTable,
      and(eq(recapDeliveriesTable.recapId, recapsTable.id), eq(recapDeliveriesTable.kind, "scheduled")),
    )
    .where(and(eq(recapsTable.householdId, householdId), eq(recapsTable.userId, userId)))
    .orderBy(desc(recapsTable.forDate))
    .limit(q.data.limit ?? 30);
  res.json(
    ListRecapHistoryResponse.parse(
      rows.map((r) =>
        historyItem(r.recap, r.deliveryStatus && r.deliveryCreatedAt ? { status: r.deliveryStatus, createdAt: r.deliveryCreatedAt } : null),
      ),
    ),
  );
});

router.post("/recap/generate-now", requireAuth, async (req, res): Promise<void> => {
  const { userId, householdId } = who(req);
  if (req.householdOwnerId !== userId) return fail(res, 403, "Only the household owner can do this.", "owner_only");
  const parsed = GenerateRecapNowBody.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "Those settings are not valid.", "invalid_body");
  const target = parsed.data.userId ?? userId;
  const [member] = await db
    .select({ userId: householdMembersTable.userId })
    .from(householdMembersTable)
    .where(and(eq(householdMembersTable.userId, target), eq(householdMembersTable.householdId, householdId)));
  if (!member) return fail(res, 400, "That person is not a member of this household.", "not_a_member");
  const settings = await ensureSettings(householdId, target);
  const when = resolveForDate(parsed.data.forDate, settings.timezone);
  if ("error" in when) return fail(res, 400, when.error, "bad_date");

  if (parsed.data.replace) {
    const [existing] = await db
      .select()
      .from(recapsTable)
      .where(and(eq(recapsTable.userId, target), eq(recapsTable.forDate, when.forDate), eq(recapsTable.householdId, householdId)));
    if (existing?.status === "sent") return fail(res, 409, "That recap was already sent.", "already_sent");
    if (existing) await db.delete(recapsTable).where(eq(recapsTable.id, existing.id));
  }
  const out = await generateRecap(householdId, target, when.forDate, {
    ownerUserId: req.householdOwnerId!,
    trigger: "user",
  });
  if (out.preview) return fail(res, 500, "Could not generate the recap.", "generate_failed");
  const [delivery] = await db
    .select({ status: recapDeliveriesTable.status, createdAt: recapDeliveriesTable.createdAt })
    .from(recapDeliveriesTable)
    .where(and(eq(recapDeliveriesTable.recapId, out.recap.id), eq(recapDeliveriesTable.kind, "scheduled")));
  res.json(GenerateRecapNowResponse.parse({ created: out.created, recap: historyItem(out.recap, delivery ?? null) }));
});

export default router;

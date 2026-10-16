import { Router, type IRouter } from "express";
import { MarkWhatsNewReadBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireHouseholdOwner } from "../middlewares/requireHouseholdOwner";
import { recordWhatsNewReads, whatsNewFor, whatsNewReadReport } from "../lib/whatsNewReads";

/**
 * ⭐ (WN) WHAT'S NEW — "I've read this", recorded per person (owner,
 * 2026-10-15). The logic is in lib/whatsNewReads.ts; the notes are in
 * `@workspace/avalanche-core/whatsNew`.
 *
 *   GET  /whats-new/me     this person's reads + where their click starts
 *   POST /whats-new/read   record a press (unknown ids dropped; repeat = no-op)
 *   GET  /whats-new/reads  the owner's "Read by <name> on <day>" report (owner only)
 *
 * A database failure answers 500: the web then neither greets nor shows the
 * read lines. Nothing here moves money.
 */
const router: IRouter = Router();

router.get("/whats-new/me", requireAuth, async (req, res): Promise<void> => {
  res.json(await whatsNewFor(req.actualUserId!));
});

router.post("/whats-new/read", requireAuth, async (req, res): Promise<void> => {
  const parsed = MarkWhatsNewReadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  res.json({ ids: await recordWhatsNewReads(req.actualUserId!, req.householdId!, parsed.data.ids) });
});

router.get("/whats-new/reads", requireAuth, requireHouseholdOwner, async (req, res): Promise<void> => {
  res.json(await whatsNewReadReport(req.householdId!, req.actualUserId!));
});

export default router;

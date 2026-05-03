import { Router, type IRouter, type Request, type Response } from "express";
import { clerkClient } from "@clerk/express";
import { requireOwner } from "../middlewares/requireOwner";
import { CheckInvitationBody, CreateInvitationBody } from "@workspace/api-zod";

const router: IRouter = Router();

function serializeInvitation(inv: {
  id: string;
  emailAddress: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  url?: string;
  revoked?: boolean;
}) {
  return {
    id: inv.id,
    emailAddress: inv.emailAddress,
    status: inv.status,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
    url: inv.url ?? null,
    revoked: inv.revoked ?? null,
  };
}

async function fetchAllInvitations(
  filter: { status?: "pending" | "accepted" | "revoked" | "expired" } = {},
): Promise<Array<{
  id: string;
  emailAddress: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  url?: string;
  revoked?: boolean;
}>> {
  const pageSize = 500;
  const max = 5000;
  const all: Array<{
    id: string;
    emailAddress: string;
    status: string;
    createdAt: number;
    updatedAt: number;
    url?: string;
    revoked?: boolean;
  }> = [];
  let offset = 0;
  while (offset < max) {
    const result = await clerkClient.invitations.getInvitationList({
      orderBy: "-created_at",
      limit: pageSize,
      offset,
      ...(filter.status ? { status: filter.status } : {}),
    });
    const page = Array.isArray(result)
      ? result
      : (result as { data: typeof result.data }).data;
    if (!page || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function getInvitationRedirectUrl(req: {
  headers: { host?: string; "x-forwarded-host"?: unknown; "x-forwarded-proto"?: unknown };
  protocol?: string;
}): string {
  const explicit = process.env.INVITATION_REDIRECT_URL;
  if (explicit) return explicit;
  const xfh = req.headers["x-forwarded-host"];
  const host =
    (Array.isArray(xfh) ? xfh[0] : (xfh as string | undefined))?.split(",")[0]?.trim() ||
    req.headers.host ||
    "localhost";
  const xfp = req.headers["x-forwarded-proto"];
  const proto =
    (Array.isArray(xfp) ? xfp[0] : (xfp as string | undefined))?.split(",")[0]?.trim() ||
    req.protocol ||
    "https";
  return `${proto}://${host}/sign-up`;
}

router.get("/invitations", requireOwner, async (_req: Request, res: Response): Promise<void> => {
  const result = await clerkClient.invitations.getInvitationList({
    orderBy: "-created_at",
    limit: 100,
  });
  const invitations = Array.isArray(result)
    ? result
    : (result as { data: typeof result.data }).data;
  res.json(invitations.map(serializeInvitation));
});

router.post("/invitations", requireOwner, async (req: Request, res: Response): Promise<void> => {
  const parsed = CreateInvitationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const inv = await clerkClient.invitations.createInvitation({
      emailAddress: parsed.data.email,
      ignoreExisting: false,
      notify: true,
      redirectUrl: getInvitationRedirectUrl(req),
    });
    res.status(201).json(serializeInvitation(inv));
  } catch (err: unknown) {
    const e = err as { status?: number; errors?: Array<{ message?: string }>; message?: string };
    const status = typeof e.status === "number" ? e.status : 500;
    const message =
      e.errors?.[0]?.message || e.message || "Failed to create invitation";
    res.status(status).json({ error: message });
  }
});

router.delete("/invitations/:id", requireOwner, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const inv = await clerkClient.invitations.revokeInvitation(id);
    res.status(200).json(serializeInvitation(inv));
  } catch (err: unknown) {
    const e = err as { status?: number; errors?: Array<{ message?: string }>; message?: string };
    const status = typeof e.status === "number" ? e.status : 500;
    const message =
      e.errors?.[0]?.message || e.message || "Failed to revoke invitation";
    res.status(status).json({ error: message });
  }
});

router.post("/invitations/:id/resend", requireOwner, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const pending = await fetchAllInvitations({ status: "pending" });
    const existing = pending.find((i) => i.id === id);
    if (!existing) {
      res.status(404).json({ error: "Pending invitation not found" });
      return;
    }
    try {
      await clerkClient.invitations.revokeInvitation(id);
    } catch (revokeErr) {
      req.log.warn({ err: revokeErr }, "Failed to revoke prior invitation while resending");
    }
    const fresh = await clerkClient.invitations.createInvitation({
      emailAddress: existing.emailAddress,
      ignoreExisting: true,
      notify: true,
      redirectUrl: getInvitationRedirectUrl(req),
    });
    res.status(201).json(serializeInvitation(fresh));
  } catch (err: unknown) {
    const e = err as { status?: number; errors?: Array<{ message?: string }>; message?: string };
    const status = typeof e.status === "number" ? e.status : 500;
    const message =
      e.errors?.[0]?.message || e.message || "Failed to resend invitation";
    res.status(status).json({ error: message });
  }
});

router.post("/invitations/check", async (req: Request, res: Response): Promise<void> => {
  const parsed = CheckInvitationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const email = parsed.data.email.toLowerCase().trim();
  try {
    const pending = await fetchAllInvitations({ status: "pending" });
    const hasPending = pending.some(
      (i) => i.emailAddress.toLowerCase().trim() === email,
    );
    res.json({ email, hasPending });
  } catch (err: unknown) {
    req.log.warn({ err }, "Failed to check pending invitation");
    res.json({ email, hasPending: false });
  }
});

export default router;

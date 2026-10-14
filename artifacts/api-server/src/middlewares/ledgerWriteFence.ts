import type { NextFunction, Request, Response } from "express";
import { bumpLedgerGeneration } from "../lib/ledgerShare";

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * ⭐ (P2) A READ THAT STARTS AFTER A WRITE NEVER JOINS A LEDGER BUILD FROM
 * BEFORE IT. Every request that may write (any method but GET, HEAD, OPTIONS)
 * moves the ledger's write generation when it starts and again when its
 * response finishes or the connection closes — so a forecast build running
 * across a write is no longer joined, and "Mark matched → the page refetches"
 * always builds on the new answer. See `lib/ledgerShare.ts`.
 */
export function ledgerWriteFence(req: Request, res: Response, next: NextFunction): void {
  if (READ_METHODS.has(req.method)) {
    next();
    return;
  }
  bumpLedgerGeneration();
  let done = false;
  const after = (): void => {
    if (done) return;
    done = true;
    bumpLedgerGeneration();
  };
  res.once("finish", after);
  res.once("close", after);
  next();
}

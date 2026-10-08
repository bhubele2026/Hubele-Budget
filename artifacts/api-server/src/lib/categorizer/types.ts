// (PR-A) Categorization engine v2 — shared types. See index.ts for the pipeline.
import type { SpendContext } from "@workspace/avalanche-core";
import type { RuleRow } from "../autoCategorize";
import type { ReplacedPending } from "../supersededPending";

export type DecisionSource =
  | "locked"
  | "rule"
  | "memory"
  | "recurring"
  | "inherited"
  | "heuristic"
  | "model"
  | "user"
  | "refund";

export type Band = "auto" | "provisional" | "queue";

/** The filing an `inherited` decision writes beside the category (never `isTransfer`). */
export interface InheritedFiling {
  weeklyAllowance: boolean;
  monthlyAllowance: boolean;
  unplannedAllowance: boolean;
  weeklyBucket: string | null;
  reimbursable: boolean;
  debtId: string | null;
  /** The pending row's lock travels with the category it hands over. */
  categoryLockedByUser: boolean;
}

/** What a stage yields. The first stage that yields wins. */
export interface StageResult {
  source: DecisionSource;
  categoryId: string | null;
  confidence: number;
  /** Short, plain; no merchant text beyond what the row already shows. */
  explanation: string;
  ruleId?: string | null;
  memoryId?: string | null;
  recurringItemId?: string | null;
  refundOfTxnId?: string | null;
  inheritedFiling?: InheritedFiling | null;
  model?: string | null;
  promptVersion?: string | null;
}

/** A transaction as the engine reads it. */
export interface EngineRow {
  id: string;
  description: string;
  amount: string;
  source: string;
  plaidAccountId: string | null;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
  pending: boolean;
  occurredOn: string;
  createdAt: Date;
  categoryId: string | null;
  categoryLockedByUser: boolean;
  categoryProvisional: boolean;
  isTransfer: boolean;
  isTransferUserOverridden: boolean;
  isExternalCardPayment: boolean;
  debtId: string | null;
  reimbursable: boolean;
  weeklyAllowance: boolean;
  monthlyAllowance: boolean;
  unplannedAllowance: boolean;
  weeklyBucket: string | null;
  refundOfTxnId: string | null;
}

export interface MemoryRow {
  id: string;
  signature: string;
  scope: "merchant" | "merchant_account" | "merchant_amount";
  plaidAccountId: string | null;
  amountBandLo: number | null;
  amountBandHi: number | null;
  categoryId: string;
  count: number;
  createdAt: Date;
}

export interface RecurringRow {
  id: string;
  name: string;
  amount: number;
  categoryId: string;
}

/** An earlier outflow a refund can point back to. */
export interface OutflowRef {
  id: string;
  occurredOn: string;
  amountAbs: number;
  categoryId: string | null;
  /** (B6) For the decision's explanation: "Refund of <description> on <date>". */
  description: string;
  /** (B6) A purchase on the refund's own account is preferred. */
  plaidAccountId: string | null;
}

/** Everything the stages read. Loaded once per batch (context.ts) or built by a test. */
export interface EngineContext {
  /** Deterministic order: priority desc, pattern length desc, created_at asc, id. */
  rules: RuleRow[];
  /** Enabled memory rows by signature. */
  memoryBySignature: Map<string, MemoryRow[]>;
  /** Active recurring items that carry a category. */
  recurring: RecurringRow[];
  /** Posted row id → the pending row it replaced (pendingSupersede pairing). */
  replacedBy: Map<string, ReplacedPending>;
  uncategorizedIds: ReadonlySet<string>;
  spendCtx: SpendContext;
  /** Outflows by refund-link signature (`refundSignature`), for refund linking. */
  outflowsBySignature: Map<string, OutflowRef[]>;
  /** Content versions folded into every input hash. */
  versions: { rules: string; memory: string; recurring: string };
}

export interface Decision {
  id: string;
  transactionId: string;
  source: DecisionSource;
  categoryId: string | null;
  previousCategoryId: string | null;
  confidence: number;
  band: Band;
  explanation: string;
}

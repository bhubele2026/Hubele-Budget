import * as XLSX from "xlsx";
import { eq } from "drizzle-orm";
import {
  db,
  debtsTable,
  budgetCategoriesTable,
  budgetMonthsTable,
  budgetLinesTable,
  recurringItemsTable,
  mappingRulesTable,
  transactionsTable,
  monthlySnapshotsTable,
} from "@workspace/db";
import { categorize, type RuleRow } from "./autoCategorize";

type Row = (string | number | Date | null)[];

const toNum = (v: unknown): string => {
  if (v === null || v === undefined || v === "" || v === "—") return "0";
  const n =
    typeof v === "number"
      ? v
      : parseFloat(String(v).replace(/[$,]/g, ""));
  return Number.isNaN(n) ? "0" : n.toFixed(2);
};
const toStr = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v);
const excelDate = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

// Returns a Date with a real time-of-day if the cell carries one, otherwise
// null. Used to populate `transactions.occurred_at` so the Reports hourly
// spending clock can chart real hours instead of fabricating them. Cells
// that resolve to exactly midnight (the common Excel "date only" sentinel)
// are treated as time-less.
const excelDateTime = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  let d: Date | null = null;
  if (v instanceof Date) {
    d = v;
  } else if (typeof v === "number") {
    const parts = XLSX.SSF.parse_date_code(v);
    if (!parts) return null;
    d = new Date(
      Date.UTC(
        parts.y,
        parts.m - 1,
        parts.d,
        parts.H ?? 0,
        parts.M ?? 0,
        Math.floor(parts.S ?? 0),
      ),
    );
  } else {
    const parsed = new Date(String(v));
    if (!Number.isNaN(parsed.getTime())) d = parsed;
  }
  if (!d) return null;
  if (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0
  ) {
    return null;
  }
  return d.toISOString();
};

const sheet = (wb: XLSX.WorkBook, name: string): Row[] => {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: null,
    blankrows: false,
  }) as Row[];
};

export async function importWorkbook(
  userId: string,
  wb: XLSX.WorkBook,
  batchId: string,
): Promise<Record<string, number>> {
  const REQUIRED = [
    "Debt Tracker",
    "Monthly Budget",
    "Recurring Items",
    "Mapping",
    "Payments",
  ];
  const missing = REQUIRED.filter((s) => !wb.Sheets[s]);
  if (missing.length) {
    throw new Error(
      `Workbook is missing required sheet(s): ${missing.join(", ")}`,
    );
  }

  const counts: Record<string, number> = {};

  return await db.transaction(async (tx) => {
    // Snapshot data we want to merge BEFORE wiping, so user-edited mapping
    // rules and manual transaction category overrides survive a re-import.
    const priorCats = await tx
      .select({ id: budgetCategoriesTable.id, name: budgetCategoriesTable.name })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.userId, userId));
    const priorCatNameById = new Map(priorCats.map((c) => [c.id, c.name]));

    const priorRules = await tx
      .select({
        pattern: mappingRulesTable.pattern,
        matchType: mappingRulesTable.matchType,
        categoryId: mappingRulesTable.categoryId,
        priority: mappingRulesTable.priority,
      })
      .from(mappingRulesTable)
      .where(eq(mappingRulesTable.userId, userId));

    const priorTx = await tx
      .select({
        occurredOn: transactionsTable.occurredOn,
        description: transactionsTable.description,
        amount: transactionsTable.amount,
        source: transactionsTable.source,
        categoryId: transactionsTable.categoryId,
      })
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, userId));
    const priorTxByKey = new Map<string, string | null>();
    for (const t of priorTx) {
      priorTxByKey.set(
        `${t.occurredOn}|${t.description}|${t.amount}|${t.source}`,
        t.categoryId,
      );
    }

    // Wipe existing user data so re-imports are deterministic
    await tx.delete(transactionsTable).where(eq(transactionsTable.userId, userId));
    await tx.delete(budgetLinesTable).where(eq(budgetLinesTable.userId, userId));
    await tx.delete(budgetMonthsTable).where(eq(budgetMonthsTable.userId, userId));
    await tx.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, userId));
    await tx.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, userId));
    await tx.delete(monthlySnapshotsTable).where(eq(monthlySnapshotsTable.userId, userId));
    await tx.delete(debtsTable).where(eq(debtsTable.userId, userId));
    await tx.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, userId));

    // Debts
    const dt = sheet(wb, "Debt Tracker");
    const debtValues: typeof debtsTable.$inferInsert[] = [];
    for (let i = 4; i < dt.length; i++) {
      const r = dt[i];
      if (!r || !r[1] || String(r[1]).toUpperCase() === "TOTALS") continue;
      const name = toStr(r[1]);
      if (!name) continue;
      debtValues.push({
        userId,
        name,
        type: toStr(r[2]),
        apr: toNum(r[3]),
        balance: toNum(r[4]),
        minPayment: toNum(r[5]),
        payment: toNum(r[5]),
      });
    }
    const insertedDebts = debtValues.length
      ? await tx.insert(debtsTable).values(debtValues).returning({
          id: debtsTable.id,
          name: debtsTable.name,
        })
      : [];
    counts.debts = insertedDebts.length;
    const debtByName = new Map(insertedDebts.map((d) => [d.name, d.id]));

    // Categories
    const mb = sheet(wb, "Monthly Budget");
    const catValues: typeof budgetCategoriesTable.$inferInsert[] = [];
    const lineSeed: { name: string; planned: string; note: string | null }[] = [];
    let order = 0;
    for (let i = 5; i < mb.length; i++) {
      const r = mb[i];
      if (!r) continue;
      const num = r[0];
      const label = toStr(r[1]);
      if (!label) continue;
      if (num === null && r[2] === null) continue;
      if (label.toLowerCase().startsWith("subtotal")) continue;
      catValues.push({
        userId,
        name: label,
        kind: "expense",
        sortOrder: order++,
      });
      lineSeed.push({
        name: label,
        planned: toNum(r[2]),
        note: toStr(r[6]),
      });
    }
    const insertedCats = catValues.length
      ? await tx.insert(budgetCategoriesTable).values(catValues).returning({
          id: budgetCategoriesTable.id,
          name: budgetCategoriesTable.name,
        })
      : [];
    counts.budget_categories = insertedCats.length;
    const catByName = new Map(insertedCats.map((c) => [c.name, c.id]));

    // Budget month + lines (current month)
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    await tx
      .insert(budgetMonthsTable)
      .values({ userId, monthStart })
      .onConflictDoNothing();
    counts.budget_months = 1;

    const lineRows = lineSeed
      .filter((l) => catByName.has(l.name))
      .map((l) => ({
        userId,
        monthStart,
        categoryId: catByName.get(l.name)!,
        plannedAmount: l.planned,
        note: l.note,
      }));
    if (lineRows.length) {
      await tx.insert(budgetLinesTable).values(lineRows);
    }
    counts.budget_lines = lineRows.length;

    // Recurring items
    const ri = sheet(wb, "Recurring Items");
    const recValues: typeof recurringItemsTable.$inferInsert[] = [];
    for (let i = 5; i < ri.length; i++) {
      const r = ri[i];
      if (!r) continue;
      const name = toStr(r[1]);
      if (!name) continue;
      const kindRaw = String(r[2] ?? "Expense").toLowerCase();
      const kind = kindRaw.includes("debt")
        ? "debt"
        : kindRaw.includes("income")
          ? "income"
          : "bill";
      recValues.push({
        userId,
        name,
        kind,
        amount: toNum(r[3]),
        frequency: (toStr(r[4]) ?? "monthly").toLowerCase(),
        dayOfMonth: r[5] != null && r[5] !== "" ? Number(r[5]) : null,
        anchorDate: excelDate(r[6]),
        active: (toStr(r[7]) ?? "true").toLowerCase() === "no" ? "false" : "true",
        categoryId: catByName.get(name) ?? null,
      });
    }
    if (recValues.length) {
      await tx.insert(recurringItemsTable).values(recValues);
    }
    counts.recurring_items = recValues.length;

    // Mapping rules
    const mp = sheet(wb, "Mapping");
    const mapValues: typeof mappingRulesTable.$inferInsert[] = [];
    for (let i = 4; i < mp.length; i++) {
      const r = mp[i];
      if (!r) continue;
      const pattern = toStr(r[0]);
      if (!pattern) continue;
      const target = toStr(r[1]);
      mapValues.push({
        userId,
        pattern,
        matchType: "contains",
        categoryId: target ? catByName.get(target) ?? null : null,
        priority: 0,
      });
    }
    const insertedRules = mapValues.length
      ? await tx.insert(mappingRulesTable).values(mapValues).returning({
          id: mappingRulesTable.id,
          pattern: mappingRulesTable.pattern,
          matchType: mappingRulesTable.matchType,
          categoryId: mappingRulesTable.categoryId,
          priority: mappingRulesTable.priority,
        })
      : [];
    counts.mapping_rules = insertedRules.length;

    // Merge user-edited mapping rules: keep any prior rule whose priority is
    // higher than the workbook seed (0), or whose (pattern, matchType) the
    // workbook does not redefine. categoryId is re-mapped by category name
    // since wiping budget_categories assigned new ids.
    const seedKeys = new Set(
      mapValues.map((v) => `${v.pattern}|${v.matchType}`),
    );
    const SEED_PRIORITY = 0;
    const preservedRuleRows = priorRules
      .filter(
        (r) =>
          r.priority > SEED_PRIORITY ||
          !seedKeys.has(`${r.pattern}|${r.matchType}`),
      )
      .map((r) => {
        const oldName = r.categoryId
          ? priorCatNameById.get(r.categoryId) ?? null
          : null;
        const remappedCat = oldName ? catByName.get(oldName) ?? null : null;
        return {
          userId,
          pattern: r.pattern,
          matchType: r.matchType,
          categoryId: remappedCat,
          priority: r.priority,
        };
      });
    const insertedPreservedRules = preservedRuleRows.length
      ? await tx
          .insert(mappingRulesTable)
          .values(preservedRuleRows)
          .returning({
            id: mappingRulesTable.id,
            pattern: mappingRulesTable.pattern,
            matchType: mappingRulesTable.matchType,
            categoryId: mappingRulesTable.categoryId,
            priority: mappingRulesTable.priority,
          })
      : [];
    counts.mapping_rules_preserved = insertedPreservedRules.length;

    // Sort highest-priority first so categorize() picks the user's most
    // specific rules before generic ones.
    const ruleRows: RuleRow[] = [...insertedRules, ...insertedPreservedRules].sort(
      (a, b) => b.priority - a.priority,
    );

    // Transactions (Payments sheet → Amex card register).
    // Each row is treated as `source = "amex"` so it shows up on the Amex
    // page and contributes to the Amex bucket of the budget source breakdown.
    // When the workbook leaves Target empty we run the rule engine so the
    // user gets out-of-the-box categorization instead of an uncategorized row.
    const pay = sheet(wb, "Payments");
    const txValues: typeof transactionsTable.$inferInsert[] = [];
    let preservedTxOverrides = 0;
    for (let i = 5; i < pay.length; i++) {
      const r = pay[i];
      if (!r || !r[1]) continue;
      const date = excelDate(r[1]);
      if (!date) continue;
      const occurredAt = excelDateTime(r[1]);
      const description = toStr(r[2]) ?? "(no description)";
      const target = toStr(r[4]);
      const typeStr = String(r[3] ?? "Expense").toLowerCase();
      const rawAmount = toNum(r[5]);
      const num = Number(rawAmount);
      const signed =
        typeStr.includes("income") || typeStr.includes("credit")
          ? num.toFixed(2)
          : (-Math.abs(num)).toFixed(2);
      const explicitCat = target ? catByName.get(target) ?? null : null;
      const auto = explicitCat
        ? { categoryId: explicitCat, isTransfer: false }
        : categorize({ description }, ruleRows);

      // Preserve manual category overrides: if the prior transaction with
      // the same (date, description, amount, source) had a categoryId that
      // differs from what we'd auto-assign now, treat it as a user edit and
      // keep their choice.
      let finalCategoryId = auto.categoryId;
      const priorCatId = priorTxByKey.get(`${date}|${description}|${signed}|amex`);
      if (priorCatId !== undefined) {
        const priorName = priorCatId
          ? priorCatNameById.get(priorCatId) ?? null
          : null;
        const remappedPrior = priorName ? catByName.get(priorName) ?? null : null;
        if ((remappedPrior ?? null) !== (auto.categoryId ?? null)) {
          finalCategoryId = remappedPrior;
          preservedTxOverrides++;
        }
      }

      txValues.push({
        userId,
        occurredOn: date,
        occurredAt,
        description,
        amount: signed,
        categoryId: finalCategoryId,
        isTransfer: auto.isTransfer,
        source: "amex",
        importBatchId: batchId,
        notes: toStr(r[7]),
      });
    }
    const CHUNK = 500;
    let txInserted = 0;
    for (let i = 0; i < txValues.length; i += CHUNK) {
      const chunk = txValues.slice(i, i + CHUNK);
      await tx.insert(transactionsTable).values(chunk);
      txInserted += chunk.length;
    }
    counts.transactions = txInserted;
    counts.transactions_preserved = preservedTxOverrides;

    // Monthly snapshots (optional sheet)
    const mt = sheet(wb, "Monthly Tracking");
    if (mt.length > 5) {
      const headerRow = mt[4] ?? [];
      const cols: { col: number; monthStart: string }[] = [];
      for (let c = 2; c < headerRow.length; c++) {
        const h = headerRow[c];
        if (!h) continue;
        const d = new Date(`1 ${h}`);
        if (!Number.isNaN(d.getTime())) {
          const ms = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
          cols.push({ col: c, monthStart: ms });
        }
      }
      const byMonth = new Map<string, Record<string, string>>();
      for (let i = 5; i < mt.length; i++) {
        const r = mt[i];
        if (!r) continue;
        const metric = toStr(r[1]);
        if (!metric) continue;
        for (const m of cols) {
          const v = r[m.col];
          if (v === null || v === undefined || v === "") continue;
          const bucket = byMonth.get(m.monthStart) ?? {};
          bucket[metric] = toNum(v);
          byMonth.set(m.monthStart, bucket);
        }
      }
      const snapValues: typeof monthlySnapshotsTable.$inferInsert[] = [];
      for (const [ms, payload] of byMonth) {
        snapValues.push({ userId, monthStart: ms, payload });
      }
      if (snapValues.length) {
        await tx
          .insert(monthlySnapshotsTable)
          .values(snapValues)
          .onConflictDoNothing();
      }
      counts.monthly_snapshots = snapValues.length;
    } else {
      counts.monthly_snapshots = 0;
    }

    // Suppress unused-warning for debt mapping (used implicitly by future features)
    void debtByName;

    return counts;
  });
}

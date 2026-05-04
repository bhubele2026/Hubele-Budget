// Shared helper that turns the API's per-rule attribution array (from a
// Plaid sync or workbook import) into a compact summary the UI can drop
// into a toast. Pulled out into its own module so the Plaid sync hook and
// the Settings page workbook-import handler render the same wording, the
// same top-N truncation, and pass the same `?focus=<id1,id2,...>` deep
// link to Mapping Rules.

export type RuleAttribution = {
  ruleId: string;
  pattern: string;
  count: number;
};

export type RuleAttributionSummary = {
  // Total number of rows credited to *any* rule in this batch — never the
  // total number of rows imported, since rows whose category came from an
  // explicit Target column or a preserved manual override aren't counted.
  totalAttributed: number;
  // Top contributors to surface in the toast description (caps at 3 to
  // keep the toast readable on narrow viewports).
  top: RuleAttribution[];
  // How many rules were trimmed off the end so the toast can render
  // ", +N more" without the user having to do the math.
  extraRules: number;
  // All touched rule ids, in input order. Used as the `?focus=` payload
  // on the Mapping Rules deep link so every rule that contributed gets
  // highlighted (not just the top three shown in the description).
  ruleIds: string[];
};

const MAX_RULES_IN_TOAST = 3;

export function buildRuleAttributionSummary(
  attributions: readonly RuleAttribution[],
): RuleAttributionSummary {
  const totalAttributed = attributions.reduce((sum, a) => sum + a.count, 0);
  const top = attributions.slice(0, MAX_RULES_IN_TOAST).map((a) => ({ ...a }));
  const extraRules = Math.max(0, attributions.length - top.length);
  const ruleIds = attributions.map((a) => a.ruleId);
  return { totalAttributed, top, extraRules, ruleIds };
}

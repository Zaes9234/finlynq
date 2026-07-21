/**
 * FINLYNQ-263 (child A) — the 10 eval flows (owner-approved, plan §8.4 / decision #4).
 *
 * Each flow is a natural-language task + the set of tool names that count as a
 * CORRECT first tool call, for BOTH the pre-consolidation (117-tool baseline)
 * and post-consolidation surfaces. The eval scores whether the model's FIRST
 * tool call is in `acceptable` for the surface under test.
 *
 * `writeFlow: true` marks a flow that would mutate data — those run against the
 * DEMO tenant only (the harness never actually executes the tool; it inspects
 * the model's tool CHOICE via the Anthropic API `tool_use` stop, so no write
 * happens — but the marker documents the intent + keeps spend scoped).
 */
export type EvalFlow = {
  id: string;
  task: string;
  /** Correct first tool on the PRE-consolidation (117-tool) surface. */
  baselineTools: string[];
  /** Correct first tool on the POST-consolidation surface. */
  consolidatedTools: string[];
  writeFlow: boolean;
};

export const EVAL_FLOWS: EvalFlow[] = [
  {
    id: "record-expense",
    task: "I spent $42.10 at Whole Foods today on groceries. Add it to my checking account.",
    baselineTools: ["record_transaction", "bulk_record_transactions"],
    consolidatedTools: ["manage_transactions"],
    writeFlow: true,
  },
  {
    id: "record-buy",
    task: "I bought 10 shares of AAPL at $190 in my brokerage account. Record the purchase.",
    baselineTools: ["portfolio_buy"],
    consolidatedTools: ["portfolio_record_entry"],
    writeFlow: true,
  },
  {
    id: "reconcile-statement",
    task: "Show me the reconciliation suggestions for my checking account so I can match imported bank rows to my transactions.",
    baselineTools: ["get_reconcile_suggestions", "get_reconciliation_summary"],
    // reconcile-consolidation: get_reconcile_suggestions folded into reconcile(op:suggest).
    consolidatedTools: ["reconcile", "get_reconciliation_summary"],
    writeFlow: false,
  },
  {
    id: "set-budget",
    task: "Set my monthly Dining budget to $400.",
    baselineTools: ["set_budget"],
    consolidatedTools: ["manage_budgets"],
    writeFlow: true,
  },
  {
    id: "add-goal",
    task: "Create a savings goal called Emergency Fund with a target of $10,000.",
    baselineTools: ["add_goal"],
    consolidatedTools: ["manage_goals"],
    writeFlow: true,
  },
  {
    id: "create-rule",
    task: "Make a rule that auto-categorizes any transaction with 'Netflix' in the payee as Entertainment.",
    baselineTools: ["create_rule"],
    consolidatedTools: ["manage_rules"],
    writeFlow: true,
  },
  {
    id: "check-net-worth",
    task: "What is my current net worth?",
    baselineTools: ["get_net_worth"],
    consolidatedTools: ["get_net_worth"],
    writeFlow: false,
  },
  {
    id: "list-subscriptions",
    task: "List all my recurring subscriptions and what they cost me each month.",
    baselineTools: ["list_subscriptions", "get_subscription_summary"],
    consolidatedTools: ["manage_subscriptions", "get_subscription_summary"],
    writeFlow: false,
  },
  {
    id: "delete-transaction",
    task: "Delete the transaction with id 812.",
    baselineTools: ["delete_transaction"],
    consolidatedTools: ["manage_transactions"],
    writeFlow: true,
  },
  {
    id: "fx-conversion",
    task: "In my brokerage account, convert 1000 USD to CAD as an FX conversion entry.",
    baselineTools: ["portfolio_fx_conversion"],
    consolidatedTools: ["portfolio_record_entry"],
    writeFlow: true,
  },
];

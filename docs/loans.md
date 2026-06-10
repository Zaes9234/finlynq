# Loans & Debt v2 (FINLYNQ-136)

Status: **dev-only** (page behind `DevModeGuard`). Phases 1–3 + 5 shipped 2026-06-10;
Phase 4 (ledger posting) deferred — see "Deferred" below.

## Model

A loan row (`loans` table, [src/db/schema-pg.ts](../src/db/schema-pg.ts)) is either:

- **Term-driven** — `term_months` set; the per-period payment is derived from
  principal/rate/term (balloon-aware when `residual_value` is set).
- **Payment-driven** — `payment_amount` set; the schedule solves for the number
  of periods and the payoff/end date. `term_months` is nullable
  (migration `20260619_loans_v2.sql`); the application layer enforces that at
  least one of (`term_months`, `payment_amount`) is present.

When both are set, **the payment wins** (the term is informational).

## Calculator (`src/lib/loan-calculator.ts`)

Pure, dependency-free (bundled into the MCP server build — keep it that way).
Single entry point:

```ts
buildLoanSchedule({
  principal, annualRate, startDate,        // required
  termMonths?, paymentAmount?,             // at least one
  paymentFrequency?, extraPayment?, residualValue?,
}): LoanSummary
```

- **Frequencies** — `PAYMENT_FREQUENCIES = weekly | biweekly | semi_monthly |
  monthly | quarterly | annual` (52/26/24/12/4/1 periods per year via
  `PERIODS_PER_YEAR`). "Bimonthly" is deliberately NOT in the enum — it is
  ambiguous (every-2-weeks vs twice-a-month vs every-2-months); biweekly +
  semi_monthly cover the two common readings. Unknown legacy strings degrade to
  monthly (`normalizeFrequency`), matching v1's fall-through.
- **Per-period rate** = `annualRate / 100 / periodsPerYear`. v1 charged the
  *monthly* rate per biweekly period — that bug is fixed; biweekly schedules
  computed before v2 differ (the feature is dev-only, no migration concern).
- **`monthlyPayment` keeps its legacy name** and means *payment per period*
  (every pre-v2 consumer reads it). Use `paymentPerPeriod` for clarity and
  `monthlyEquivalentPayment` (= payment × periodsPerYear / 12) for
  cross-frequency comparisons/sums (the UI "Monthly Payments" tile sums this).
- **Per-month interest accrual** — `summary.monthlyAccrual: {month: "YYYY-MM",
  interest}[]`. Each period's interest is day-weighted across the calendar
  months the period spans (interval `(prevPaymentDate, paymentDate]`). This is
  the *reportable* monthly figure regardless of payment frequency; it sums to
  `totalInterest` within per-entry cent rounding.
- **Lease residual** — `residualValue` amortizes the balance down to the
  residual instead of 0: term-driven payments use the balloon annuity formula
  (`calculatePeriodPayment(principal, r, n, residual)`), payment-driven
  schedules stop when the balance reaches the residual. Balance at term end ==
  residual, NOT 0.
- **Validation** — `LoanValidationError` (name `LoanValidationError`) is thrown
  for user-correctable inputs and MUST be mapped to a 4xx/refusal, never a 500:
  payment + extra ≤ first period's interest ("never amortizes"), residual ≥
  principal, principal ≤ 0, neither term nor payment, payoff > 100 years
  (runaway-loop backstop for payments barely above interest).
- **Dates** are UTC-anchored and month-stepping clamps to month-end
  (Jan 31 + 1mo = Feb 28/29). Semi-monthly alternates +15 days / next month
  anchor day.
- `generateAmortizationSchedule(principal, rate, termMonths, start, extra?,
  freq?)` survives as the term-driven back-compat wrapper (what-if + scenarios
  still use it).

## Account-linked balance

`GET /api/loans` and MCP `list_loans` read the outstanding balance from the
linked account (`loans.account_id`) when that account has ledger activity:

- `remainingBalance = |SUM(transactions.amount)|` over the linked account —
  liability accounts carry negative balances, the absolute value also covers
  users who track the loan balance as positive.
- `txCount > 0` gates the switch: an account with no transactions falls back to
  the projection (so a freshly-linked empty account doesn't zero the loan).
- `balanceSource: "account" | "projection"` tells the UI which it got (the
  loans page shows a "· from account" badge).
- When account-driven, the payoff date / periods remaining are **re-anchored**:
  a payment-driven schedule is run from today's actual balance with the loan's
  payment (falling back to projection dates if that payment no longer
  amortizes the actual balance).

`principal` stays the opening balance (NOT mutated). The "dedicated liability
account as source of truth" model from the ticket can layer on in Phase 4 when
posting starts writing transactions — nothing here blocks it.

## Surfaces

- **REST** ([src/app/api/loans/route.ts](../src/app/api/loans/route.ts)) —
  POST/PUT validate via the calculator and return the validation message as a
  400 (`LoanValidationError` mapping; PUT validates the **merged** row).
  The `amortization` action accepts `paymentAmount` + `residualValue` and
  returns `monthlyAccrual`.
- **UI** ([src/app/(app)/loans/page.tsx](<../src/app/(app)/loans/page.tsx>)) —
  Payment ("From term" placeholder) + Frequency + lease-only Residual/Buyout
  inputs; term placeholder "From payment"; server 400s surface inline in the
  dialog; schedule view has a **Monthly Interest** tab.
- **MCP HTTP** — `add_loan` / `update_loan` accept `residual_value`, the
  6-value `payment_frequency` enum, optional `term_months`; both refuse
  non-amortizing inputs with the validation message. `get_loan_amortization`
  honors stored payment/residual and returns `monthlyAccrual`.
  `get_debt_payoff_plan` excludes non-amortizing rows per-row (in `excluded`)
  instead of throwing. Same for the **stdio** read tools (stdio writes still
  refuse per Stream D Phase 4).

## Deferred (Phase 4 — tracked on FINLYNQ-136)

- Posting the principal/interest split into `transactions` (principal =
  balance movement, interest = expense), auto-generate (recurring-style) vs
  import-and-reconcile modes, FI-sync duplicate matching, balance
  reconciliation surface (warn-but-allow), and the posting-trigger /
  categorization decisions that come with it.
- Variable / floating rates (schema designed so a rate-schedule table can slot
  in additively — do NOT widen `annual_rate` semantics).
- GA gating: the page stays behind `DevModeGuard`.

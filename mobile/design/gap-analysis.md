# Mobile ↔ Web gap analysis

Purpose: map what the **web app** offers vs what the **mobile app** currently has, so we can
decide together: **add to mobile**, **keep web-only**, or **defer**.

> **Refreshed 2026-06-01.** The original (2026-05-29) was a *design-phase* doc written when mobile
> had 9 mocked screens. Since then the Wealth screens, create-flows, and Transfer shipped to
> `mobile-dev`, so most of the original "➕ add" rows are now **done**. This rewrite reflects the
> **shipped** mobile state in `pf-mobile/mobile/` (20 screens, 5 tabs) against the current web
> surface. Source of truth: mobile = [`src/api/client.ts`](../src/api/client.ts) `endpoints` + the
> screens; web = [`pf-app/src/components/nav.tsx`](../../src/components/nav.tsx) + the route inventory.

Legend: **✅ parity** · **◑ partial** (exists but reduced — read-only or create-only) ·
**❌ absent** · **🖥️ web-only by design** · **🔶 defer (phase 2)**.
Web items tagged **(dev)** are gated behind dev-mode and are **not in the prod web UI yet**, so a
mobile gap against them is lower priority for end users today.

---

## A. What mobile has today (20 screens, 5 tabs)

Bottom tabs (Option B, "Wealth-led"): **Home · Accounts · Portfolio · Transactions · More**.
Everything else lives in the **More** hub.

- **Home** — Dashboard (net worth, assets/liabilities, monthly income/expense, savings rate,
  health-score ring, top-5 budget progress, recent transactions).
- **Accounts** — list + grouping → AccountDetail (recent tx) · **Add account** (create).
- **Portfolio** — full parity: holdings, allocation, performance / realized-gains / dividends, **and
  all 8 investment write ops** (buy/sell/swap/transfer/income-expense/fx/brokerage). Shipped 2026-06-02.
- **Transactions** — list + search → TransactionDetail (view / **edit** / **delete**) · **Add**
  (expense / income / **transfer**).
- **More** hub:
  - *Get started* — Load sample data
  - *Add* — Add transaction, Transfer
  - *Tracking* — Budgets (full CRUD), Goals (list + create), Categories (list + create), Import (lite)
  - *Tools* — What's New (announcements), Settings, Send feedback, Sign out
- **Auth** — Login / Register, biometric Lock screen.

That now covers **daily capture + review + Wealth glance + budgets + goals + onboarding**. The
holes are **analysis/planning surfaces**, **investment-op entry**, **edit/delete on a few entities**,
and **deep configuration** — detailed below.

---

## B. Page-level comparison (every web nav item)

| Web nav item | Route | prod/dev | On mobile? | Recommendation | Why |
|---|---|---|---|---|---|
| Dashboard | `/dashboard` | prod | ✅ have | keep | daily home |
| Transactions | `/transactions` | prod | ✅ have (CRUD) | keep | core ledger |
| Budgets | `/budgets` | prod | ✅ have (CRUD) | keep | monthly tracking |
| Goals | `/goals` | prod | ◑ create-only | **➕ wire edit/delete** | endpoints exist; just no UI |
| Accounts (+ `/accounts/[id]`) | `/accounts` | prod | ◑ create-only | **➕ wire edit/delete/archive** | balances + detail done |
| Portfolio | `/portfolio` | prod | ✅ parity | keep | full write + reporting shipped 2026-06-02 |
| Import | `/import` | prod | ◑ lite (pick→preview→execute) | keep lite | full pipeline stays web |
| Settings | `/settings` | prod | ◑ subset | **➕ committed (P4)** | currency toggle + edit/delete + reconcile mode/thresholds → plan/mobile-settings-expansion.md |
| What's New | `/whats-new` | prod | ✅ have | keep | announcements + read state |
| Reports | `/reports` | prod | ❌ | **➕ committed (P2) — full parity** | income/balance/trends + Sankey + YoY → plan/mobile-reports.md |
| MCP Guide | `/mcp-guide` | prod | ❌ | 🖥️ web-only | setup/reference doc; link from Settings |
| Admin / Inbox / Announcements / Feedback (admin) | `/admin*` | prod (admin) | ❌ | 🖥️ web-only | operator tooling |
| AI Chat | `/chat` | dev | ❌ | 🔶 later (fast-track) | conversational → strong phone fit |
| Subscriptions | `/subscriptions` | dev | ❌ | 🔶 later | simple list + next-bill |
| Calendar | `/calendar` | dev | ❌ | 🔶 later | bills/income calendar |
| Loans & Debt | `/loans` | dev | ❌ | 🔶 later | status glance ok; amortization web |
| Reconcile | `/reconcile` + `/inbox` | dev | ❌ | **➕ committed (P3) — inbox subset** | approve/categorize card flows + mode picker; two-pane N×M stays web → plan/mobile-reconcile-inbox.md |
| Tax | `/tax` | dev | ❌ | 🖥️ web-only | form-heavy calculators |
| Scenarios | `/scenarios` | dev | ❌ | 🖥️ web-only | planning calculators |
| FIRE Calculator | `/fire` | dev | ❌ | 🖥️ web-only | calculator + Monte Carlo |
| API Docs | `/api-docs` | dev | ❌ | 🖥️ web-only | developer reference |

Also web-only by nature (real surfaces, not main-nav rows): **Rules editor**, **FX overrides**,
**Settings sub-pages** (api keys, backup/restore, integrations, holding-accounts, investments,
categorization, dropdown order, dev mode, **delete account**), **Backfill wizard**, **Portfolio
sub-pages** (dividends, realized gains, performance, rebalancing, ETF breakdown), **Import
staging/pending + connectors (WealthPosition) + email import**. All 🖥️ web-only — configuration or
wide-table surfaces.

---

## C. Feature-level gaps *inside* flows we already have

The "missing transfers"-type holes — capabilities the web has that the current mobile screens
can't do. (The first two rows from the old doc are now **shipped**; kept here for continuity.)

| Capability | Web has it | Mobile today | Recommendation |
|---|---|---|---|
| ~~Transfers (account → account)~~ | yes | ✅ same-currency (Add → Transfer) | **done** |
| ~~Edit transaction~~ | yes | ✅ TransactionDetail view/edit/delete | **done** |
| **Cross-currency / FX transfers** | yes | ❌ refused server-side (409 `fx-currency-needs-override`) | 🖥️ web-only |
| **Edit/delete Goals** | yes | ◑ create-only | **➕ committed (P4)** — endpoints exist |
| **Edit/delete/archive Accounts** + reconciliation-mode picker | yes | ◑ create-only | **➕ committed (P4)** — edit/delete/archive + mode picker |
| **Edit/delete Categories** | yes | ◑ create-only | **➕ committed (P4)** |
| **Budget templates / seed-from-history / envelope / Age-of-Money** | yes | ❌ (CRUD only) | 🔶 later |
| **Splits** (one tx across categories) | yes | ❌ | **➕ committed (P1)** → plan/mobile-splits.md |
| **Linked transfer pairs / bulk ops / audit log / tx suggestions** | yes | ❌ | 🖥️ web-only |
| **Advanced tx filters / sort / custom columns** | yes | ❌ (search only) | 🔶 later (basic filters) |
| **Investment ops** (buy/sell/dividend/FX/brokerage/swap) | yes (`/portfolio/new`) | ✅ parity (shipped 2026-06-02) | done |
| **Portfolio sub-views** (dividends, realized gains, performance) | yes | ✅ shipped 2026-06-02 (rebalancing / ETF-xray still web) | done |
| **Auto-categorize rules** | yes (`/settings/rules`) | ❌ | 🖥️ web-only |
| **Reconcile / approve-each / inbox modes** | yes | ❌ | **➕ committed (P3)** — inbox approve/categorize + mode picker; two-pane web-only → plan/mobile-reconcile-inbox.md |
| **Import: templates / staging review / connectors / email / backfill** | yes | ❌ (lite import only) | 🖥️ web-only |
| **Net-worth trend / spending charts (Reports)** | yes | ❌ (dashboard shows numbers only) | **➕ committed (P2) — full parity** → plan/mobile-reports.md |
| **Multi-currency display toggle** | yes (Settings → General) | ❌ | **➕ committed (P4)** to Settings |
| **MFA / password reset / email verify** | yes | ❌ (login + register only) | 🖥️ web-only for now |
| **Data export / backup / restore / delete account** | yes | ❌ (web `/account-deletion` satisfies Play's delete-URL req) | 🖥️ web-only |
| **FX overrides** | yes | ❌ | 🖥️ web-only |

---

## D. Mobile information architecture (shipped)

Bottom tab bar holds **5 items** (RN constraint); everything else is in the **More** hub
(`MoreScreen`). The shipped IA is **Option B — Wealth-led**:

**Tabs:** `Home · Accounts · Portfolio · Transactions · More`
**More hub** (grouped, mirrors web `navGroups` labels): *Get started* (Load sample data) ·
*Add* (Add transaction, Transfer) · *Tracking* (Budgets, Goals, Categories, Import) ·
*Tools* (What's New, Settings, Send feedback, Sign out).

The earlier Option A (center ➕ FAB) and Option C (web-mirror bar) were considered and **not**
chosen — see the resolution log below. No center FAB; Add/Transfer live in **More** + the
Transactions tab header.

---

## E. Decision log

### RESOLVED — 2026-05-29 (design phase)
1. Add to mobile: Accounts (+detail), Portfolio (read-only), Goals, Transfers (in Add).
2. Web-only: Reconcile, Tax, Scenarios, FIRE, Rules, Admin, API Docs, deep Settings,
   investment-op entry, Backfill, MCP Guide.
3. Phase 2 (deferred): AI Chat, Subscriptions, Calendar, Loans, Reports-lite.
4. Mobile menu = Option B (Wealth-led).

### SHIPPED since — through 2026-06-01
- ✅ Accounts (list + detail + **create**), Portfolio (read-only), Goals (list + **create**),
  Categories (list + **create**) — closes the "no way to create foundational entities" launch blocker.
- ✅ Transfers (same-currency) in the Add flow; cross-currency refused server-side → web.
- ✅ Transaction **edit + delete** (TransactionDetail), Budgets **full CRUD**.
- ✅ Load sample data (one-tap onboarding), What's New (announcements + read state), Send feedback.
- ✅ Option B tab bar + More hub IA, theme re-skin (web tokens + lucide), light/dark/system toggle.

### OPEN — recommended next (priority order)
1. **Quick wins (endpoints already exist; UI only):**
   - Edit/delete for **Goals**, **Accounts** (+ archive), **Categories**.
   - **Display-currency** toggle in Settings.
2. **Medium (read screens for existing prod features):**
   - **Reports-lite** (net-worth trend + spending), **Subscriptions** list, **Loans** status glance.
3. **Fast-track despite dev-gate:** **AI Chat** — strongest phone fit of the dev-gated set.
4. **Stays web-only:** Reconcile two-pane, Rules editor, Portfolio investment *entry* + sub-views,
   Import full pipeline, deep Settings, FX overrides, Admin, Backfill, MCP Guide, MFA/backup/delete.

> Note: this doc lives in the `mobile-dev` worktree (`pf-mobile/mobile/design/`). The copy under
> `pf-app/mobile/design/` is on the `dev` branch and will sync on the next `mobile-dev → dev` merge.

---

## F. Committed roadmap — 2026-06-02

User committed to closing four gaps **in this order**. Each has a self-contained plan doc (repo root
`plan/`) and ships as its own `mobile-dev` build. Backend is unchanged for all four (every REST route
already exists; mobile holds the session DEK). Build **sequentially** — all four target `mobile-dev`
and several touch `shared/types.ts`.

| # | Feature | Scope | Plan doc |
|---|---|---|---|
| **P1** | **Splits** | Split editor on TransactionDetail; `/api/transactions/splits` atomic-replace. Smallest. | `plan/mobile-splits.md` |
| **P2** | **Reports — FULL parity** | Income statement + balance sheet + trends + **Sankey** + **YoY** + custom date range. Largest (net-new SVG Sankey + date picker). | `plan/mobile-reports.md` |
| **P3** | **Reconcile — inbox subset** | Account-anchored **Approve + Categorize** card flows + per-account mode picker. Two-pane N×M stays web. | `plan/mobile-reconcile-inbox.md` |
| **P4** | **Settings expansion** | Display-currency toggle + edit/delete Goals/Accounts/Categories + reconcile mode picker & thresholds. | `plan/mobile-settings-expansion.md` |

**Shared component:** P3 and P4 both use `src/components/inbox/ModePicker.tsx` — whichever ships first
creates it. **Still deferred / web-only:** AI Chat, Subscriptions, Calendar, Loans, budget templates,
rules editor, FX overrides, backup/restore, API keys, dropdown order, holding-accounts, backfill, the
reconcile two-pane grid, MFA/password-reset.

# Finlynq — Google Play submission content (paste-ready)

All copy + every "App content" / Data Safety / content-rating answer for the Play
Console, plus the graphics checklist. Package `com.finlynq.mobile`. Target
audience already set to **18 and over**.

> **Status (2026-05-31):** Closed-testing track is **Active and submitted for Google
> review** (release 1.0.0 (2), 177 countries, Google-Groups testers wired). DONE this
> session: 512 store icon (§2), phone screenshots captured (§2), short + full
> description rewritten to clear Play's performance/ranking-keyword filter (§1),
> Advertising-ID = No verified (§3), Google Group `finlynq-testers` created + web-joinable
> + wired into the Closed track, recruitment posts finalized (§7c). Previously DONE: Data
> Safety (§5), target-audience 18+, deletion URL (§6), content-rating answers (§4).
> REMAINING (user-side): wait for review to clear, then fire the §7c posts, recruit 12+
> testers, keep them opted-in 14 continuous days, and apply for production access.

---

## 1. Store listing

**App name** (≤30): `Finlynq`

**Short description** (≤80):
```
Private finance for accounts, budgets, investments and net worth
```
> ⚠️ Play short-description rules (learned the hard way):
> 1. No ranking/performance words. Google flagged "Privacy-FIRST" because "first"
>    reads as a ranking term. Avoid: first, best, top, #1, number one, leading,
>    most/most-downloaded, popular, trending, new, sale, free, award-winning.
> 2. No call-to-action ("download now", "install now", "try now"). A noun phrase
>    ("Private finance for...") sidesteps this.
> 3. Single sentence = NO trailing period. (Periods only allowed when there are
>    multiple sentences.)
> 4. No special chars / symbols / repeated punctuation. Spell out "and" instead
>    of "&", drop the colon. Commas are fine.
> 5. Sentence case; only capitalize the app name if the listing name is capitalized.

**Full description** (≤4000):
```
Finlynq is a personal finance app that brings everything together: bank accounts, credit cards, spending, budgets, investments, loans, goals, and net worth. It lets you analyze it all anywhere with AI.

Track your money here, analyze it anywhere.

WHAT YOU CAN DO
• Accounts & net worth: See every account (assets and liabilities) and your real-time net worth, across multiple currencies.
• Transactions: Record income and expenses, categorize spending, and review recent activity at a glance.
• Budgets: Set monthly budgets per category and track progress as you spend.
• Investments: Follow your portfolio with holdings, cost basis, gains, and dividends, with live prices for stocks, crypto, and precious metals.
• Goals: Set savings and debt-payoff goals and watch your progress.
• Loans: Track mortgages, student loans, and other debt with amortization detail.
• Multi-currency: Accurate conversion with historical exchange rates so your totals are always right.
• Import: Bring in transactions from CSV, Excel, OFX, or PDF statements.

BUILT FOR AI
Finlynq ships a built-in MCP server, so you can connect AI assistants and ask natural questions about your money: "How much did I spend on groceries last month?", "What's my savings rate?", "Show my portfolio's realized gains this year." Your assistant works with your real data, securely.

PRIVATE BY DESIGN
• Your financial data is encrypted in transit and at rest.
• No ads. No third-party trackers. We don't sell your data.
• Open source (AGPL v3): inspect the code or run it yourself.
• Donation-funded, not data-funded.

HOSTED OR SELF-HOSTED
Use the hosted version at finlynq.com, or run your own server with Docker and PostgreSQL and point the app at it. The server URL is configurable in Settings.

A Finlynq account is required to use the app. You can delete your account and all associated data at any time.
```

**App category:** Finance
**Tags:** personal finance, budgeting, investing
**Contact email:** <your support/developer email> (e.g. support@finlynq.com)
**Website:** https://finlynq.com
**Privacy policy:** https://finlynq.com/privacy

---

## 2. Graphics checklist

| Asset | Spec | Status |
|---|---|---|
| App icon (store listing) | 512×512 PNG (32-bit, alpha) | ✅ generated → `mobile/store/store-icon-512.png` (regen: `node scripts/generate-store-icon.mjs`). NOTE: this is a SEPARATE upload from the in-build launcher icon (`assets/icon.png`, 1024²); Play Console's Store listing → Graphics asks for the 512² file. |
| Feature graphic | 1024×500 PNG/JPG, no alpha | ✅ generated → `mobile/store/feature-graphic.png` (regen: `node scripts/generate-feature-graphic.mjs`) |
| Phone screenshots | 2–8 images, PNG/JPG, each side 320–3840px, 16:9 or 9:16 | ⬜ **you capture on your phone** |

**Screenshots to capture** (4–6 recommended, portrait): Dashboard (net worth + recent), Accounts list, Account detail, Portfolio, Transactions, Budgets. Grab them from the installed app (Android: power + volume-down), then upload under Store listing → Phone screenshots.

---

## 3. App content declarations (Dashboard → Policy → App content)

| Section | Answer |
|---|---|
| **Privacy policy** | `https://finlynq.com/privacy` |
| **Ads** | No, my app does **not** contain ads. |
| **Advertising ID** | **No** — app does not use the advertising ID. Verified 2026-05-31: zero ad/analytics SDKs in `package.json`, and no dependency manifest/gradle declares `com.google.android.gms.permission.AD_ID` (grepped all of `node_modules`). Consistent with Data Safety "Device or other IDs = No". Do NOT answer Yes — that would make Play block releases lacking the AD_ID permission. |
| **App access** | Some/all functionality is restricted (login required) → provide the reviewer login below. |
| **Content rating** | Complete the questionnaire (section 4). |
| **Target audience & content** | Target age **18 and over**; "designed to appeal to children" → **No**. |
| **Data safety** | Section 5. |
| **Government apps** | No. |
| **Financial features** | **My app does not provide any of these financial features.** Finlynq only *tracks/displays* the user's own data — it does not originate loans, manage debt, move money, provide banking/e-money, or execute trades/crypto exchange. |
| **Health** | No. |
| **News app** | No. |
| **COVID-19 contact tracing/status** | No. |

### App access — reviewer login (paste into "Instructions")
```
All functionality requires signing in. The app connects to finlynq.com by default.

Username: demo@finlynq.com
Password: finlynq-demo

This is a shared demo account preloaded with sample data (it resets nightly). After signing in, all features are reachable from the bottom tabs (Home, Accounts, Portfolio, Transactions) and the More tab (Budgets, Goals, Settings).
```

---

## 4. Content rating (IARC questionnaire)

- **Category:** Utility, Productivity, Communication, or Other (it's a finance utility, not a game).
- Violence / realistic violence → **No**
- Sexual content or nudity → **No**
- Profanity or crude humor → **No**
- Controlled substances (drugs, alcohol, tobacco) → **No**
- Gambling — real or simulated → **No**
- Fear / horror → **No**
- Discrimination / hate → **No**
- Users can **interact, communicate, or share content** with each other → **No** (personal data only; no social features, no user-to-user messaging)
- Shares the user's **physical location** with other users → **No**
- Lets users **purchase digital goods** / contains in-app purchases → **No**
- Any other potentially objectionable content → **No**

**Expected rating:** Everyone (PEGI 3 / ESRB Everyone).

---

## 5. Data Safety (Dashboard → App content → Data safety)

**Does your app collect or share any required user data types?** → **Yes**
**Is all user data encrypted in transit?** → **Yes** (HTTPS/TLS to the backend)
**Account creation methods:** → **Username and password** (email counts as a username; no OAuth; biometric is local-unlock only)
**Do you provide a way to request data deletion?** → **Yes**
**Delete account URL** → `https://finlynq.com/account-deletion`
**Delete data URL** → `https://finlynq.com/account-deletion` (same page covers both)

**Data collected — Shared = No for every item. ✅ This is the FINAL submitted state (matches the Play CSV export, verified 2026-05-30):**

| Category → Data type | Collected | Required/Optional | Processed ephemerally | Purpose |
|---|---|---|---|---|
| Personal info → Name | Yes | Optional | **No** | App functionality, Account management |
| Personal info → Email address | Yes | Optional | **No** | App functionality, Account management |
| Personal info → User IDs (username) | Yes | Required | **No** | App functionality, Account management |
| Financial info → Other financial info (balances, transactions, budgets, investments) | Yes | Required | **No** | App functionality |
| **Files and docs** (uploaded CSV/Excel/OFX/PDF statements for import) | Yes | Optional | **Yes** (parsed server-side; raw file not retained as a file) | App functionality |

> **Name + Email** come from the in-app register form ([LoginScreen.tsx](../src/screens/LoginScreen.tsx) "Create Account" mode: optional display name + optional email). **Other financial info** = the user's transactions/balances/budgets the app reads + writes ([AddTransactionScreen.tsx](../src/screens/AddTransactionScreen.tsx) `createTransaction`/`recordTransfer`) — a finance app MUST declare this or review flags it. **User IDs ephemeral = No** (the username is stored on the account, not discarded). **Files and docs ephemeral = Yes** because the Import screen uploads a statement file (`expo-document-picker` → `/api/import/preview` + `/api/import/execute`) that's parsed into transactions server-side and not kept as a file.

**Everything else → NOT collected**, specifically:
- Location, Phone number, Physical address, Contacts, Calendar — No
- Messages, Photos/Videos, Audio — No
- Health & fitness — No
- **Device or other IDs** — No (no analytics/ad SDKs)
- **App activity / Web history** — No
- **App info & performance / Crash logs / Diagnostics** — No (the in-app diagnostics log is **local-only**, never transmitted → not "collected" per Google's definition)
- Financial info → User payment info / Purchase history / Credit score — No

**Data shared with third parties:** **None.** The app talks only to your own Finlynq backend (first-party / self-hostable). No ad networks, no third-party analytics.

**Security practices:**
- Encrypted in transit → **Yes**
- Users can request deletion → **Yes**
- Independent security review → **No** (optional; skip)
- Committed to Play Families Policy → **N/A** (18+)

---

## 6. ✅ Data-deletion URL — DONE (was the one gap; now closed)
Google requires a reachable URL where users can request account/data deletion.
**Shipped + live on prod:** [`https://finlynq.com/account-deletion`](https://finlynq.com/account-deletion)
(source: [src/app/account-deletion/page.tsx](../../src/app/account-deletion/page.tsx)) — names
the app, lists the in-app deletion steps (`finlynq.com → Settings → Data →
Delete account`), gives an email fallback (`privacy@finlynq.com`), and states
retention (logs 30d, encrypted backups 7d). Used for BOTH Data Safety deletion
fields. Returns HTTP 200; registered in `seo/site.ts` STATIC_ROUTES.

---

## 7. Path to production (reminder)
- **Personal account:** Closed testing → ≥12 testers opted-in ≥14 days → apply for production access → promote Closed → Production (same `.aab`, no rebuild).
- **Organization account:** finish the above sections → create a Production release directly (no 12-tester/14-day gate).
- Subsequent uploads after the first manual one: `cd pf-app/mobile && EAS_NO_VCS=1 eas.cmd submit -p android --profile production` (needs `play-service-account.json`).

### 7a. Closed testing — tester configuration (Personal-account route)

**⚠️ Internal testing does NOT count toward the 12/14 requirement.** The clock runs
only on a **Closed testing** track.

1. **Move the build to Closed.** Test and release → Testing → **Closed testing** →
   (default "Alpha" track or create one) → **Promote release** from Internal
   testing. Same `.aab` (`versionCode 2`), no rebuild.
2. **Add testers** (Closed testing → **Testers** tab):
   - **Email list** — for a fixed ~12 known people. Edit in Play Console to change.
   - **Google Group** — for open/churning recruitment. Manage in the group; count =
     opted-in members. Recommended if sourcing testers publicly.
3. **Share the opt-in URL** Play generates. Each tester must: open link → "Become a
   tester" → **install from Play** using the SAME Google account signed into their
   phone's Play Store. (Mismatched account = doesn't count — the #1 failure mode.)
4. **The clock:** ≥12 testers opted-in, kept opted-in **14 continuous days** →
   "Apply for production access" unlocks → Google review → promote Closed →
   Production.

**Tester tracker** (need ≥12; keep opted-in through the 14-day window):

| # | Name | Google account email (device Play account) | Opted in? | Installed? |
|---|------|---------------------------------------------|-----------|------------|
| 1 |  |  | ⬜ | ⬜ |
| 2 |  |  | ⬜ | ⬜ |
| 3 |  |  | ⬜ | ⬜ |
| 4 |  |  | ⬜ | ⬜ |
| 5 |  |  | ⬜ | ⬜ |
| 6 |  |  | ⬜ | ⬜ |
| 7 |  |  | ⬜ | ⬜ |
| 8 |  |  | ⬜ | ⬜ |
| 9 |  |  | ⬜ | ⬜ |
| 10 |  |  | ⬜ | ⬜ |
| 11 |  |  | ⬜ | ⬜ |
| 12 |  |  | ⬜ | ⬜ |
| +buffer |  |  | ⬜ | ⬜ |

> Add 2–3 buffer testers above 12 — if anyone uninstalls or opts out mid-window the
> count can dip below 12 and reset your standing for the production-access review.

**Opt-in URL (confirmed):** web `https://play.google.com/apps/testing/com.finlynq.mobile` · Android store link 404s for non-testers, don't share it.

### 7b. Recruitment — open-source community (chosen route)

**Mechanism: Google Group** (roster churns without Play Console edits). Create at
groups.google.com (`finlynq-testers@googlegroups.com`, "Anyone can join"), then add
the group address as the sole entry in a Closed-testing email list.

**Links every recruitment post needs (confirmed live 2026-05-31):**
- Group join: `https://groups.google.com/g/finlynq-testers` (group `finlynq-testers@googlegroups.com`,
  "Anyone on the web can join")
- Opt-in (web): `https://play.google.com/apps/testing/com.finlynq.mobile`
- Source: `https://github.com/finlynq/finlynq`
- ❌ NOT `play.google.com/store/apps/details?id=com.finlynq.mobile` — 404s for non-testers.

**Config confirmed:** Closed-testing track Active, Testers = Google Groups →
`finlynq-testers@googlegroups.com`; group is web-joinable. Feedback contact set to
`feedback@finlynq.com` (verify it's a monitored inbox). Installs may lag until the
first release review clears; group→Play tester propagation can take minutes–hours.

**⚠️ Engagement matters, not just installs.** Google reviews real testing when you
apply for production access. Testers should use REAL devices (emulators don't count)
and actually open the app during the 14 days. Recruit 14–15 for buffer.

**Channels (priority order):**
- _Genuine/on-brand:_ your GitHub repo (Discussion + README callout), r/selfhosted,
  r/opensource, r/fossdroid, Mastodon (#Android #FOSS), Lemmy (programming.dev,
  lemmy.ml/c/opensource), F-Droid forum. Lead with the AGPL/self-hostable/privacy hook.
- _Highest-yield reciprocal exchange:_ r/androiddev closed-testing megathreads (the
  intended place — reciprocate), r/TestersCommunity (+ testerscommunity.com "Packs" of
  16 devs/16 days), r/AndroidAppTesters, r/betatesting, r/alphaandbetausers.
- _Last resort:_ paid services (PrimeTestLab ~$15/12 testers) — lower-trust, engagement-risk.

### 7c. Recruitment posts (final, ready to fire once review clears)

Real links baked in. No em dashes (kept hyphens in compound words). Post the GitHub
one first, then r/selfhosted + Mastodon, then the r/androiddev exchange + r/TestersCommunity.

**① GitHub** (pin a Discussion + add a README "Testers wanted" callout):
```
📱 Android testers wanted: help Finlynq pass Google Play's 12-tester gate

Finlynq's Android app is in Play closed testing. Google requires 12 testers opted-in for 14 days before a solo-dev app can publish. If you're on Android and want to help an AGPL, self-hostable, privacy-first finance app ship:

1. Join the testers group: https://groups.google.com/g/finlynq-testers
2. On your phone, open https://play.google.com/apps/testing/com.finlynq.mobile, tap "Become a tester", then install from Play
3. Use the same Google account signed into your phone's Play Store, or it won't count
4. Open the app a few times over the next 2 weeks. Google checks for genuine testing.

Try the demo (demo@finlynq.com / finlynq-demo) or your own data. Bugs/feedback welcome in Issues. 🙏
```

**② Reddit FOSS** (r/selfhosted, r/opensource, r/fossdroid — check each sub's self-promo rule):
```
Title: Open-source (AGPL), self-hostable finance app: need Android testers to clear Play's 12-tester rule

I built Finlynq: privacy-first personal finance, encrypted, no trackers/ads, self-hostable with Docker + Postgres, and it ships an MCP server so you can query your finances with an AI assistant. It's in Play closed testing, but Google needs 12 testers for 14 days before a personal account can publish.

1. Join: https://groups.google.com/g/finlynq-testers
2. On your phone: https://play.google.com/apps/testing/com.finlynq.mobile, then Become a tester and install
3. Same Google account as your phone's Play Store
4. Use it here and there over ~2 weeks

Code (AGPL): https://github.com/finlynq/finlynq. Happy to reciprocate and answer anything. Thanks!
```

**③ Reddit exchange / reciprocal** (r/androiddev megathreads, r/TestersCommunity, r/AndroidAppTesters, r/betatesting):
```
Title: [Testing] Finlynq, an open-source finance app. I'll test yours back

Closed-testing exchange. I'll opt into your app today and use it through the window. 🤝
My app: Finlynq (open-source personal finance, AGPL).
- Join group: https://groups.google.com/g/finlynq-testers
- Opt in: https://play.google.com/apps/testing/com.finlynq.mobile
Drop yours below (group + opt-in link) and I'll join right away.
```

**④ Mastodon / Lemmy / X:**
```
Finlynq is an open-source, self-hostable, privacy-first finance app with a built-in MCP server. It needs 12 Android testers to clear Google Play's launch gate. Join: https://groups.google.com/g/finlynq-testers then opt in on your phone: https://play.google.com/apps/testing/com.finlynq.mobile and give it a spin over 2 weeks. AGPL: github.com/finlynq/finlynq #Android #FOSS #opensource 🙏
```

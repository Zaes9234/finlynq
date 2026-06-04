import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Claude Code worktrees — not part of the app source
    ".claude/**",
    // Mobile is a separate React Native (Expo) workspace with its own CI lane
    // (mobile-ci.yml: tsc + jest). This Next.js *web* config (core-web-vitals +
    // React Compiler rules) is the wrong linter for RN code — Expo doesn't run
    // the React Compiler, so rules like `react-hooks/preserve-manual-memoization`
    // are false positives on mobile screens. Excluding `mobile/**` keeps the
    // blocking web lint (FINLYNQ-112) from gating React Native code on web-only
    // rules. If mobile wants linting, add an RN-appropriate config under mobile-ci.
    "mobile/**",
  ]),
  {
    // ── FINLYNQ-112 ESLint baseline ──────────────────────────────────────
    // These rules each carry a pre-existing violation backlog (178 errors
    // total across 12 rules on the dev HEAD this baseline was originally cut
    // against). They are downgraded from `error` to `warn` so the blocking
    // ESLint CI step (ci.yml `Lint`) gates only on errors — `npm run lint`
    // exits 0 with warnings, non-zero on any error. Every rule NOT listed
    // here keeps its current severity, so the CI step still catches any
    // FUTURE new-rule error. Burn down each rule's backlog and re-promote it
    // to `error` here per the follow-up; the step's teeth grow as that
    // happens. Do NOT add new violations of these rules — fix them at source.
    //
    // FINLYNQ-119 (2026-06-04) burned down + RE-PROMOTED the 7 quick-win /
    // small-count rules — they were removed from this block and now run at
    // their default `error` severity (zero violations repo-wide):
    //   prefer-const, react-hooks/rules-of-hooks, react-hooks/use-memo,
    //   react-hooks/immutability, react-hooks/static-components,
    //   @typescript-eslint/ban-ts-comment, @next/next/no-html-link-for-pages.
    // The 5 large backlogs below + preserve-manual-memoization stay `warn`
    // (each is its own follow-up PR).
    rules: {
      "@typescript-eslint/no-require-imports": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "react/display-name": "warn",
      "react/no-unescaped-entities": "warn",
      // eslint-plugin-react-hooks 7.1.1 (lockfile) errors on this React
      // Compiler diagnostic ("Existing memoization could not be preserved") in
      // 3 web components (inbox-to-approve-tab, inbox-to-categorize-tab,
      // sankey-chart). It surfaced on the dev→main promotion PR — the blocking
      // lint is PR-only and these reached `dev` via direct pushes, so it was
      // never gated. Baselined to `warn` per the policy above; burn down + re-
      // promote to `error`. (An optimization hint, not a correctness bug.)
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
]);

export default eslintConfig;

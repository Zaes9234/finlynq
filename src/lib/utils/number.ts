/**
 * Shared numeric utilities.
 *
 * Canonical home for `round2` — the half-up-to-2-decimals helper used across
 * write paths, aggregators, and API routes. Historically every module that
 * needed it declared its own private `const round2 = (n) => Math.round(n*100)/100`;
 * FINLYNQ-145 consolidated them here. `currency-conversion.ts` re-exports this
 * so existing `import { round2 } from "@/lib/currency-conversion"` callsites keep
 * working unchanged.
 *
 * NOTE: `src/lib/loan-calculator.ts` intentionally keeps its OWN private copy —
 * it is bundled into the MCP build and must stay dependency-free. Do not point
 * it here.
 */

/** Round a number to 2 decimal places (currency precision). */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

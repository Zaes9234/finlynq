/**
 * Unit tests for the FINLYNQ-177 single-transaction `id` deep-link key
 * flowing through the pure `buildTransactionQuery` builder.
 *
 * `buildTransactionQuery` is the byte-stable single source of truth for the
 * GET `/api/transactions` request params (FINLYNQ-111 Phase 1). These tests
 * pin that the new `id` filter is emitted as `?id=<n>` (the owner-scoped
 * single-tx pushdown the route reads back) and that it doesn't perturb the
 * existing keys when unset.
 */
import { describe, it, expect } from "vitest";
import { buildTransactionQuery, type TxFilters } from "@/lib/transactions/build-query";

const NO_SORT = { columnId: null, direction: null } as const;
const PAGE = { page: 0, limit: 50 };

function emptyFilters(): TxFilters {
  return {
    startDate: "",
    endDate: "",
    accountId: "",
    categoryId: "",
    search: "",
    portfolioHolding: "",
    tag: "",
    id: "",
  };
}

describe("buildTransactionQuery — single-tx id (FINLYNQ-177)", () => {
  it("emits ?id=<n> when the id filter is set", () => {
    const params = buildTransactionQuery(
      { ...emptyFilters(), id: "42" },
      NO_SORT,
      [],
      [],
      PAGE,
    );
    expect(params.get("id")).toBe("42");
  });

  it("does NOT emit an id key when the filter is empty", () => {
    const params = buildTransactionQuery(emptyFilters(), NO_SORT, [], [], PAGE);
    expect(params.has("id")).toBe(false);
  });

  it("emits id alongside other filters without dropping them", () => {
    const params = buildTransactionQuery(
      { ...emptyFilters(), id: "7", categoryId: "5" },
      NO_SORT,
      [],
      [],
      PAGE,
    );
    expect(params.get("id")).toBe("7");
    expect(params.get("categoryId")).toBe("5");
  });
});

import { describe, it, expect } from "vitest";
import {
  calculateMonthlyPayment,
  generateAmortizationSchedule,
  calculateDebtPayoff,
  calculateExtraPaymentImpact,
  buildLoanSchedule,
  LoanValidationError,
} from "@/lib/loan-calculator";

describe("calculateMonthlyPayment", () => {
  it("computes correct payment for standard mortgage", () => {
    // $300,000 at 5% for 30 years (360 months)
    const payment = calculateMonthlyPayment(300000, 5, 360);
    expect(payment).toBeCloseTo(1610.46, 0);
  });

  it("handles 0% interest rate", () => {
    const payment = calculateMonthlyPayment(12000, 0, 12);
    expect(payment).toBe(1000);
  });

  it("handles short-term loan", () => {
    // $1,000 at 12% for 12 months
    const payment = calculateMonthlyPayment(1000, 12, 12);
    expect(payment).toBeCloseTo(88.85, 0);
  });
});

describe("generateAmortizationSchedule", () => {
  it("generates correct number of periods for simple loan", () => {
    const result = generateAmortizationSchedule(12000, 0, 12, "2024-01-01");
    expect(result.schedule.length).toBeLessThanOrEqual(12);
    expect(result.monthlyPayment).toBe(1000);
  });

  it("ends with zero balance", () => {
    const result = generateAmortizationSchedule(10000, 5, 60, "2024-01-01");
    const lastRow = result.schedule[result.schedule.length - 1];
    expect(lastRow.balance).toBe(0);
  });

  it("total payments = monthly * periods (approx for 0% rate)", () => {
    const result = generateAmortizationSchedule(12000, 0, 12, "2024-01-01");
    expect(result.totalPayments).toBeCloseTo(12000, 0);
    expect(result.totalInterest).toBeCloseTo(0, 0);
  });

  it("total interest is positive for non-zero rates", () => {
    const result = generateAmortizationSchedule(100000, 6, 120, "2024-01-01");
    expect(result.totalInterest).toBeGreaterThan(0);
  });

  it("extra payments reduce total interest and schedule length", () => {
    const baseline = generateAmortizationSchedule(100000, 6, 360, "2024-01-01", 0);
    const withExtra = generateAmortizationSchedule(100000, 6, 360, "2024-01-01", 200);
    expect(withExtra.schedule.length).toBeLessThan(baseline.schedule.length);
    expect(withExtra.totalInterest).toBeLessThan(baseline.totalInterest);
  });

  it("each row has principal + interest = payment (approx)", () => {
    const result = generateAmortizationSchedule(50000, 5, 60, "2024-01-01");
    for (const row of result.schedule) {
      const computed = row.interest + row.principal;
      expect(computed).toBeCloseTo(row.payment, 1);
    }
  });
});

describe("calculateDebtPayoff", () => {
  const debts = [
    { id: 1, name: "Credit Card", balance: 5000, rate: 22, minPayment: 100 },
    { id: 2, name: "Car Loan", balance: 15000, rate: 5, minPayment: 300 },
    { id: 3, name: "Student Loan", balance: 20000, rate: 6, minPayment: 200 },
  ];

  it("avalanche pays off highest-rate first", () => {
    const result = calculateDebtPayoff(debts, 200, "avalanche");
    expect(result.strategy).toBe("avalanche");
    expect(result.order[0].name).toBe("Credit Card");
    expect(result.totalMonths).toBeGreaterThan(0);
    expect(result.totalInterest).toBeGreaterThan(0);
  });

  it("snowball pays off smallest-balance first", () => {
    const result = calculateDebtPayoff(debts, 200, "snowball");
    expect(result.strategy).toBe("snowball");
    expect(result.order[0].name).toBe("Credit Card"); // smallest balance
  });

  it("avalanche saves more interest than snowball", () => {
    const avalanche = calculateDebtPayoff(debts, 200, "avalanche");
    const snowball = calculateDebtPayoff(debts, 200, "snowball");
    expect(avalanche.totalInterest).toBeLessThanOrEqual(snowball.totalInterest);
  });

  it("all debts are eventually paid off", () => {
    const result = calculateDebtPayoff(debts, 200, "avalanche");
    expect(result.order).toHaveLength(3);
    result.order.forEach((o) => expect(o.paidOffMonth).toBeGreaterThan(0));
  });
});

// ── FINLYNQ-136 — Loans & Debt v2 ────────────────────────────────────────────

describe("buildLoanSchedule — payment-driven", () => {
  it("solves the term/end date from the payment (matches the 30y reference)", () => {
    // $300,000 at 5% — the 30-year reference payment is $1,610.46.
    const result = buildLoanSchedule({
      principal: 300000,
      annualRate: 5,
      startDate: "2024-01-01",
      paymentAmount: 1610.46,
      paymentFrequency: "monthly",
    });
    expect(result.schedule.length).toBeGreaterThanOrEqual(359);
    expect(result.schedule.length).toBeLessThanOrEqual(361);
    expect(result.payoffDate >= "2053-11-01" && result.payoffDate <= "2054-02-01").toBe(true);
    expect(result.schedule[result.schedule.length - 1].balance).toBe(0);
  });

  it("rejects a payment at or below the first period's interest", () => {
    // $100,000 at 12% monthly → first period interest is $1,000.
    expect(() =>
      buildLoanSchedule({ principal: 100000, annualRate: 12, startDate: "2024-01-01", paymentAmount: 900 })
    ).toThrow(LoanValidationError);
    expect(() =>
      buildLoanSchedule({ principal: 100000, annualRate: 12, startDate: "2024-01-01", paymentAmount: 1000 })
    ).toThrow(/does not cover/);
  });

  it("rejects a payment that takes over 100 years to amortize", () => {
    // Interest is exactly $1000/period; $1000.005 amortizes in ~102 years.
    expect(() =>
      buildLoanSchedule({ principal: 100000, annualRate: 12, startDate: "2024-01-01", paymentAmount: 1000.005 })
    ).toThrow(/100 years/);
  });

  it("requires either a term or a payment", () => {
    expect(() =>
      buildLoanSchedule({ principal: 1000, annualRate: 5, startDate: "2024-01-01" })
    ).toThrow(LoanValidationError);
  });
});

describe("buildLoanSchedule — payment frequencies", () => {
  it.each([
    ["weekly", 52],
    ["biweekly", 26],
    ["semi_monthly", 24],
    ["monthly", 12],
    ["quarterly", 4],
    ["annual", 1],
  ])("0%% 12-month loan at %s frequency → %i periods, zero final balance", (freq, n) => {
    const r = buildLoanSchedule({
      principal: 1200,
      annualRate: 0,
      termMonths: 12,
      startDate: "2024-01-01",
      paymentFrequency: freq as string,
    });
    expect(r.schedule.length).toBe(n);
    expect(r.periodsPerYear).toBe(n);
    expect(r.schedule[r.schedule.length - 1].balance).toBe(0);
  });

  it("charges the per-period rate, not the monthly rate (biweekly = annual/26)", () => {
    const r = buildLoanSchedule({
      principal: 26000,
      annualRate: 5.2,
      termMonths: 12,
      startDate: "2024-01-01",
      paymentFrequency: "biweekly",
    });
    expect(r.schedule[0].interest).toBeCloseTo((26000 * 0.052) / 26, 2);
  });

  it("monthlyEquivalentPayment normalizes the per-period payment", () => {
    const weekly = buildLoanSchedule({
      principal: 12000,
      annualRate: 0,
      termMonths: 12,
      startDate: "2024-01-01",
      paymentFrequency: "weekly",
    });
    expect(weekly.monthlyEquivalentPayment).toBeCloseTo((weekly.paymentPerPeriod * 52) / 12, 2);
  });

  it("unknown legacy frequency strings degrade to monthly", () => {
    const r = buildLoanSchedule({
      principal: 1200,
      annualRate: 0,
      termMonths: 12,
      startDate: "2024-01-01",
      paymentFrequency: "bimonthly",
    });
    expect(r.paymentFrequency).toBe("monthly");
    expect(r.schedule.length).toBe(12);
  });
});

describe("buildLoanSchedule — per-month interest accrual", () => {
  it("accrual sums to total interest", () => {
    const r = buildLoanSchedule({
      principal: 100000,
      annualRate: 6,
      termMonths: 120,
      startDate: "2024-01-15",
      paymentFrequency: "biweekly",
    });
    const sum = r.monthlyAccrual.reduce((s, m) => s + m.interest, 0);
    expect(sum).toBeCloseTo(r.totalInterest, 0);
  });

  it("monthly frequency books each period's interest in its own month", () => {
    const r = buildLoanSchedule({
      principal: 12000,
      annualRate: 12,
      termMonths: 12,
      startDate: "2024-01-01",
    });
    expect(r.monthlyAccrual.length).toBe(12);
    // First period: Jan 1 → Feb 1 belongs to January.
    expect(r.monthlyAccrual[0].month).toBe("2024-01");
    expect(r.monthlyAccrual[0].interest).toBeCloseTo(120, 2);
  });

  it("a period straddling a month boundary is split by days", () => {
    // Single biweekly period Jan 25 → Feb 8: 7 days in each month.
    const r = buildLoanSchedule({
      principal: 1000,
      annualRate: 10,
      startDate: "2024-01-25",
      paymentAmount: 1100,
      paymentFrequency: "biweekly",
    });
    expect(r.schedule.length).toBe(1);
    const jan = r.monthlyAccrual.find((m) => m.month === "2024-01");
    const feb = r.monthlyAccrual.find((m) => m.month === "2024-02");
    expect(jan).toBeDefined();
    expect(feb).toBeDefined();
    expect(jan!.interest).toBeCloseTo(feb!.interest, 2);
    // Per-month entries are rounded to cents individually — allow 1¢ drift.
    expect(jan!.interest + feb!.interest).toBeCloseTo(r.totalInterest, 1);
  });
});

describe("buildLoanSchedule — lease residual", () => {
  it("term-driven lease ends at the residual, not zero", () => {
    const r = buildLoanSchedule({
      principal: 40000,
      annualRate: 4.8,
      termMonths: 36,
      startDate: "2024-01-01",
      residualValue: 18000,
    });
    expect(r.schedule.length).toBe(36);
    expect(r.schedule[r.schedule.length - 1].balance).toBeCloseTo(18000, 0);
    expect(r.residualValue).toBe(18000);
    // Lease payment is lower than a full-amortization loan over the same term.
    const fullLoan = buildLoanSchedule({ principal: 40000, annualRate: 4.8, termMonths: 36, startDate: "2024-01-01" });
    expect(r.paymentPerPeriod).toBeLessThan(fullLoan.paymentPerPeriod);
  });

  it("payment-driven lease stops at the residual", () => {
    const r = buildLoanSchedule({
      principal: 30000,
      annualRate: 6,
      startDate: "2024-01-01",
      paymentAmount: 500,
      residualValue: 12000,
    });
    expect(r.schedule[r.schedule.length - 1].balance).toBeCloseTo(12000, 1);
  });

  it("rejects residual >= principal", () => {
    expect(() =>
      buildLoanSchedule({ principal: 10000, annualRate: 5, termMonths: 36, startDate: "2024-01-01", residualValue: 10000 })
    ).toThrow(LoanValidationError);
  });
});

describe("buildLoanSchedule — date handling", () => {
  it("clamps month-end start dates instead of overflowing", () => {
    const r = buildLoanSchedule({
      principal: 1200,
      annualRate: 0,
      termMonths: 3,
      startDate: "2024-01-31",
    });
    // Jan 31 + 1mo = Feb 29 (2024 is a leap year), not Mar 2.
    expect(r.schedule[0].date).toBe("2024-02-29");
    expect(r.schedule[1].date).toBe("2024-03-31");
  });
});

describe("calculateExtraPaymentImpact", () => {
  it("returns impact for each extra payment amount", () => {
    const impacts = calculateExtraPaymentImpact(100000, 6, 360, "2024-01-01", [0, 100, 500]);
    expect(impacts).toHaveLength(3);
    expect(impacts[0].monthsSaved).toBe(0);
    expect(impacts[0].interestSaved).toBe(0);
  });

  it("more extra payment = more savings", () => {
    const impacts = calculateExtraPaymentImpact(100000, 6, 360, "2024-01-01", [100, 200, 500]);
    expect(impacts[1].interestSaved).toBeGreaterThan(impacts[0].interestSaved);
    expect(impacts[2].interestSaved).toBeGreaterThan(impacts[1].interestSaved);
    expect(impacts[1].monthsSaved).toBeGreaterThanOrEqual(impacts[0].monthsSaved);
  });
});

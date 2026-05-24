"use client";

/**
 * Portfolio operations chooser — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * Six tile-style cards for the high-level portfolio operations. The same
 * page renders the chosen form when `?op=` is present so deep-links land
 * straight in the form (search params via useSearchParams; wrapped in
 * Suspense per Next 16 App Router).
 */

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ShoppingCart,
  TrendingDown,
  ArrowRightLeft,
  Send,
  Receipt,
  Globe2,
  ArrowLeft,
  ArrowDownToLine,
  ArrowUpFromLine,
  type LucideIcon,
} from "lucide-react";
import BuyForm from "@/components/portfolio/forms/BuyForm";
import SellForm from "@/components/portfolio/forms/SellForm";
import SwapForm from "@/components/portfolio/forms/SwapForm";
import TransferForm from "@/components/portfolio/forms/TransferForm";
import IncomeExpenseForm from "@/components/portfolio/forms/IncomeExpenseForm";
import FxConversionForm from "@/components/portfolio/forms/FxConversionForm";
import DepositForm from "@/components/portfolio/forms/DepositForm";
import WithdrawalForm from "@/components/portfolio/forms/WithdrawalForm";

type OpKey =
  | "buy"
  | "sell"
  | "swap"
  | "transfer"
  | "income-expense"
  | "fx-conversion"
  | "deposit"
  | "withdrawal";

interface OpTile {
  key: OpKey;
  title: string;
  description: string;
  icon: LucideIcon;
}

const OPS: OpTile[] = [
  {
    key: "buy",
    title: "Buy",
    description: "Acquire shares — debits the matching cash sleeve.",
    icon: ShoppingCart,
  },
  {
    key: "sell",
    title: "Sell",
    description: "Realize a position — proceeds land on the cash sleeve.",
    icon: TrendingDown,
  },
  {
    key: "swap",
    title: "Swap",
    description: "Sell one holding + buy another in the same account.",
    icon: ArrowRightLeft,
  },
  {
    key: "transfer",
    title: "In-kind transfer",
    description: "Move shares between two investment accounts.",
    icon: Send,
  },
  {
    key: "income-expense",
    title: "Income / expense",
    description: "Dividends, interest, custodial fees on a cash sleeve.",
    icon: Receipt,
  },
  {
    key: "fx-conversion",
    title: "FX conversion",
    description: "Convert one currency sleeve to another in the same account.",
    icon: Globe2,
  },
  {
    key: "deposit",
    title: "Deposit",
    description: "Fund a brokerage cash sleeve from a non-investment account.",
    icon: ArrowDownToLine,
  },
  {
    key: "withdrawal",
    title: "Withdrawal",
    description: "Move cash out of a brokerage sleeve to a non-investment account.",
    icon: ArrowUpFromLine,
  },
];

function isOpKey(v: string | null): v is OpKey {
  if (!v) return false;
  return OPS.some((o) => o.key === v);
}

function PortfolioNewInner() {
  const router = useRouter();
  const params = useSearchParams();
  const opParam = params.get("op");
  const op: OpKey | null = isOpKey(opParam) ? opParam : null;

  if (op) {
    return (
      <div className="container mx-auto max-w-2xl space-y-4 p-6">
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => router.push("/portfolio/new")}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            Operations
          </Button>
          <Link
            href="/portfolio"
            className="text-sm text-muted-foreground hover:underline"
          >
            Portfolio overview →
          </Link>
        </div>
        {op === "buy" && <BuyForm />}
        {op === "sell" && <SellForm />}
        {op === "swap" && <SwapForm />}
        {op === "transfer" && <TransferForm />}
        {op === "income-expense" && <IncomeExpenseForm />}
        {op === "fx-conversion" && <FxConversionForm />}
        {op === "deposit" && <DepositForm />}
        {op === "withdrawal" && <WithdrawalForm />}
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">New portfolio operation</h1>
          <p className="text-sm text-muted-foreground">
            Pick the operation that matches what happened in your account.
          </p>
        </div>
        <Link
          href="/portfolio"
          className="text-sm text-muted-foreground hover:underline self-center"
        >
          ← Portfolio
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {OPS.map((o) => {
          const Icon = o.icon;
          return (
            <Link
              key={o.key}
              href={`/portfolio/new?op=${o.key}`}
              className="group"
            >
              <Card className="h-full transition-colors hover:border-primary/40 hover:bg-muted/30">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <div className="rounded-md border border-border/50 bg-muted/40 p-1.5">
                      <Icon className="h-4 w-4 text-primary" />
                    </div>
                    <CardTitle>{o.title}</CardTitle>
                  </div>
                  <CardDescription>{o.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <span className="text-xs text-muted-foreground group-hover:text-primary">
                    Open →
                  </span>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function PortfolioNewPage() {
  return (
    <Suspense
      fallback={
        <div className="container mx-auto max-w-2xl p-6 text-sm text-muted-foreground">
          Loading…
        </div>
      }
    >
      <PortfolioNewInner />
    </Suspense>
  );
}

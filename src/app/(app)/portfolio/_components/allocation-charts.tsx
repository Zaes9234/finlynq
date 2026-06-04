"use client";

/**
 * Allocation Overview sub-surface (FINLYNQ-118 Phase 3).
 *
 * The "By Asset Type" + "By Account" pie/legend grid. Extracted verbatim from
 * portfolio/page.tsx — the allocation arrays are computed on the page (from
 * `byType` / `byAccount` + `summary`) and passed in, so this component stays
 * purely presentational.
 */

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { Wallet, PieChart as PieChartIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { ColorDot } from "@/components/csp-safe-bar";
import { ExposurePieTooltip } from "./portfolio-ui";
import { PIE_COLORS } from "../_types";

type AllocationByTypeRow = { name: string; value: number; pct: number; color: string };
type AllocationByAccountRow = { name: string; value: number; pct: number };

export function AllocationCharts({
  allocationByType,
  allocationByAccount,
  displayCurrency,
}: {
  allocationByType: AllocationByTypeRow[];
  allocationByAccount: AllocationByAccountRow[];
  displayCurrency: string;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* By Asset Type */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <PieChartIcon className="h-4 w-4 text-indigo-500" />
            <CardTitle className="text-base">By Asset Type</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-6">
            <div className="w-36 h-36 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={allocationByType}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={36}
                    outerRadius={64}
                    strokeWidth={2}
                    stroke="var(--color-card)"
                  >
                    {allocationByType.map((d, i) => (
                      <Cell key={i} fill={d.color} />
                    ))}
                  </Pie>
                  <Tooltip content={<ExposurePieTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex-1 space-y-2 min-w-0">
              {allocationByType.map(d => (
                <div key={d.name} className="flex items-center gap-2">
                  <ColorDot color={d.color} className="h-2.5 w-2.5" />
                  <span className="text-xs text-muted-foreground flex-1">{d.name}</span>
                  <span className="text-xs font-medium tabular-nums">{formatCurrency(d.value, displayCurrency)} ({d.pct}%)</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* By Account */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-violet-500" />
            <CardTitle className="text-base">By Account</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-6">
            <div className="w-36 h-36 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={allocationByAccount}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={36}
                    outerRadius={64}
                    strokeWidth={2}
                    stroke="var(--color-card)"
                  >
                    {allocationByAccount.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<ExposurePieTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex-1 space-y-1.5 min-w-0 max-h-36 overflow-y-auto">
              {allocationByAccount.map((d, i) => (
                <div key={d.name} className="flex items-center gap-2">
                  <ColorDot color={PIE_COLORS[i % PIE_COLORS.length]} className="h-2.5 w-2.5" />
                  <span className="text-xs text-muted-foreground flex-1 truncate">{d.name}</span>
                  <span className="text-xs font-medium tabular-nums">{formatCurrency(d.value, displayCurrency)} ({d.pct}%)</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

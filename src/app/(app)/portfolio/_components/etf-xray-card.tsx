"use client";

/**
 * ETF X-Ray sub-surface (FINLYNQ-118 Phase 3, dev-only).
 *
 * Extracted verbatim from portfolio/page.tsx. The look-through tabs
 * (Stocks / Regions / Sectors / Per ETF). The tab + stocks-page state stay
 * on the page (passed in) so the page keeps a single source of view-state;
 * the derived region/sector arrays are computed on the page and passed in.
 */

import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
} from "recharts";
import {
  BarChart3, Globe2, Building2, ChevronLeft, ChevronRight, Layers, Search, Download,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";
import { ColorDot, CspSafeColorBar } from "@/components/csp-safe-bar";
import { ExposurePieTooltip } from "./portfolio-ui";
import { exportStocksToCSV } from "./csv";
import { SECTOR_COLORS, type EtfXrayTab, type OverviewData } from "../_types";

type ExposureRow = { name: string; pct: number; color: string };

export function EtfXrayCard({
  etfXray,
  etfXrayTab,
  setEtfXrayTab,
  stocksPage,
  setStocksPage,
  stocksPerPage,
  regionData,
  sectorData,
  displayCurrency,
}: {
  etfXray: OverviewData["etfXray"];
  etfXrayTab: EtfXrayTab;
  setEtfXrayTab: (t: EtfXrayTab) => void;
  stocksPage: number;
  setStocksPage: React.Dispatch<React.SetStateAction<number>>;
  stocksPerPage: number;
  regionData: ExposureRow[];
  sectorData: ExposureRow[];
  displayCurrency: string;
}) {
  const STOCKS_PER_PAGE = stocksPerPage;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-indigo-500" />
              <CardTitle className="text-base">ETF X-Ray</CardTitle>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Effective exposure across {etfXray.etfCount} ETF{etfXray.etfCount !== 1 ? "s" : ""} in your portfolio
            </p>
          </div>
          <div className="flex gap-1">
            {([
              { key: "stocks" as const, label: "Stocks", icon: BarChart3 },
              { key: "regions" as const, label: "Regions", icon: Globe2 },
              { key: "sectors" as const, label: "Sectors", icon: Building2 },
              { key: "etfs" as const, label: "Per ETF", icon: Layers },
            ]).map(tab => (
              <Button
                key={tab.key}
                variant={etfXrayTab === tab.key ? "default" : "outline"}
                size="sm"
                className="text-xs h-7 px-2.5"
                onClick={() => setEtfXrayTab(tab.key)}
              >
                <tab.icon className="h-3 w-3 mr-1" />
                {tab.label}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* ── Stocks Tab: Aggregated look-through ── */}
        {etfXrayTab === "stocks" && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Your effective stock exposure across all ETFs, weighted by each ETF&apos;s portfolio allocation.
            </p>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">#</TableHead>
                    <TableHead>Stock</TableHead>
                    <TableHead>Ticker</TableHead>
                    <TableHead>Sector</TableHead>
                    <TableHead>Country</TableHead>
                    <TableHead className="text-right">Weight</TableHead>
                    <TableHead className="text-right">Value (CAD)</TableHead>
                    <TableHead className="w-28">Exposure</TableHead>
                    <TableHead>Via ETFs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {etfXray.aggregatedStocks
                    .slice((stocksPage - 1) * STOCKS_PER_PAGE, stocksPage * STOCKS_PER_PAGE)
                    .map((s, i) => {
                      const globalIdx = (stocksPage - 1) * STOCKS_PER_PAGE + i;
                      return (
                        <TableRow key={s.ticker} className={`hover:bg-muted/30 transition-colors ${s.ticker === "OTHER" ? "bg-muted/20 border-t" : ""}`}>
                          <TableCell className="text-xs text-muted-foreground font-mono">{globalIdx + 1}</TableCell>
                          <TableCell className={`text-sm ${s.ticker === "OTHER" ? "italic text-muted-foreground" : "font-medium"}`}>{s.name}</TableCell>
                          <TableCell>
                            {s.ticker !== "OTHER" && <Badge variant="secondary" className="font-mono text-xs">{s.ticker}</Badge>}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className="text-[10px]"
                              ref={(el: HTMLElement | null) => {
                                if (el) {
                                  const c = SECTOR_COLORS[s.sector] ?? "#64748b";
                                  el.style.borderColor = c;
                                  el.style.color = c;
                                }
                              }}
                            >
                              {s.sector}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{s.country}</TableCell>
                          <TableCell className="text-right">
                            <span className="text-sm font-mono font-semibold">{s.effectiveWeight.toFixed(1)}%</span>
                          </TableCell>
                          <TableCell className="text-right">
                            <span className="text-sm font-mono text-muted-foreground">{formatCurrency(s.effectiveValueDisplay, "CAD")}</span>
                          </TableCell>
                          <TableCell>
                            <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full rounded-full bg-indigo-500"
                                ref={(el) => {
                                  if (el) el.style.width = `${Math.min(s.effectiveWeight * 10, 100)}%`;
                                }}
                              />
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1 flex-wrap">
                              {s.contributingEtfs.map((e, ei) => (
                                <span key={`${e.symbol}-${ei}`} className="text-[10px] font-mono text-muted-foreground bg-muted px-1 py-0.5 rounded">
                                  {e.symbol} {e.weight}%
                                </span>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </div>
            {etfXray.aggregatedStocks.length > 0 && (() => {
              const totalPages = Math.ceil(etfXray.aggregatedStocks.length / STOCKS_PER_PAGE);
              const totalWeight = etfXray.aggregatedStocks.reduce((s, x) => s + x.effectiveWeight, 0);
              return (
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {etfXray.aggregatedStocks.length} stocks · Total weight: {totalWeight.toFixed(1)}%
                  </p>
                  <div className="flex items-center gap-2">
                    {totalPages > 1 && (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 w-7 p-0"
                          disabled={stocksPage <= 1}
                          onClick={() => setStocksPage(p => p - 1)}
                        >
                          <ChevronLeft className="h-3 w-3" />
                        </Button>
                        <span className="text-xs text-muted-foreground px-1">
                          {stocksPage} / {totalPages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 w-7 p-0"
                          disabled={stocksPage >= totalPages}
                          onClick={() => setStocksPage(p => p + 1)}
                        >
                          <ChevronRight className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs gap-1.5"
                      onClick={() => exportStocksToCSV(etfXray.aggregatedStocks, etfXray.etfTotalValueDisplay, displayCurrency)}
                    >
                      <Download className="h-3 w-3" />
                      Export CSV
                    </Button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* ── Regions Tab ── */}
        {etfXrayTab === "regions" && (
          <div className="space-y-4">
            {regionData.length > 0 ? (
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
                <div className="w-48 h-48 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={regionData}
                        dataKey="pct"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={45}
                        outerRadius={85}
                        strokeWidth={2}
                        stroke="var(--color-card)"
                      >
                        {regionData.map((d, i) => (
                          <Cell key={i} fill={d.color} />
                        ))}
                      </Pie>
                      <Tooltip content={<ExposurePieTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex-1 space-y-2 min-w-0">
                  {regionData.map(d => (
                    <div key={d.name} className="flex items-center gap-2">
                      <ColorDot color={d.color} className="h-3 w-3" />
                      <span className="text-sm text-muted-foreground flex-1">{d.name}</span>
                      <div className="flex items-center gap-2">
                        <div className="w-24 h-2 rounded-full bg-muted overflow-hidden">
                          <CspSafeColorBar percent={d.pct} color={d.color} />
                        </div>
                        <span className="text-sm font-mono font-semibold w-12 text-right">{d.pct}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No region data available.</p>
            )}
          </div>
        )}

        {/* ── Sectors Tab ── */}
        {etfXrayTab === "sectors" && (
          <div className="space-y-4">
            {sectorData.length > 0 ? (
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
                <div className="w-48 h-48 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={sectorData}
                        dataKey="pct"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={45}
                        outerRadius={85}
                        strokeWidth={2}
                        stroke="var(--color-card)"
                      >
                        {sectorData.map((d, i) => (
                          <Cell key={i} fill={d.color} />
                        ))}
                      </Pie>
                      <Tooltip content={<ExposurePieTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex-1 space-y-2 min-w-0">
                  {sectorData.map(d => (
                    <div key={d.name} className="flex items-center gap-2">
                      <ColorDot color={d.color} className="h-3 w-3" />
                      <span className="text-sm text-muted-foreground flex-1">{d.name}</span>
                      <div className="flex items-center gap-2">
                        <div className="w-24 h-2 rounded-full bg-muted overflow-hidden">
                          <CspSafeColorBar percent={d.pct} color={d.color} />
                        </div>
                        <span className="text-sm font-mono font-semibold w-12 text-right">{d.pct}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No sector data available.</p>
            )}
          </div>
        )}

        {/* ── Per ETF Tab ── */}
        {etfXrayTab === "etfs" && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Your ETF holdings and their weight in the ETF portfolio.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ETF</TableHead>
                  <TableHead>Fund Name</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Holdings</TableHead>
                  <TableHead className="text-right">Portfolio Weight</TableHead>
                  <TableHead className="w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {etfXray.etfs.map(etf => (
                  <TableRow key={`${etf.symbol}-${etf.account}`} className="hover:bg-muted/30 transition-colors">
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-xs">{etf.symbol}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm font-medium">{etf.fullName}</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{etf.account}</TableCell>
                    <TableCell className="text-right text-sm font-mono text-muted-foreground">
                      {etf.totalHoldings.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="text-sm font-mono font-semibold">{etf.weightPct}%</span>
                    </TableCell>
                    <TableCell>
                      <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-indigo-500"
                          ref={(el) => {
                            if (el) el.style.width = `${Math.min(etf.weightPct, 100)}%`;
                          }}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

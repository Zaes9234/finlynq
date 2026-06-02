"use client";

/**
 * Rebuild investment history button — triggers a synchronous re-materialize of
 * the user's daily `portfolio_snapshots` from their first transaction to today
 * (POST /api/portfolio/snapshots/rebuild). Used by the Settings → Investments
 * card AND the net-worth chart's empty-state.
 *
 * The nightly snapshot cron is forward-only, so a back-dated investment edit
 * leaves history stale until either the auto-rebuild drain cron catches up or
 * the user clicks this. Idempotent on the snapshot unique index — safe to
 * re-run.
 *
 * plan/net-worth-over-time.md Part B.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

type Variant = "default" | "outline" | "secondary" | "ghost";
type Size = "sm" | "default" | "lg";

export function RebuildSnapshotsButton({
  onDone,
  variant = "outline",
  size = "sm",
  label = "Rebuild investment history",
}: {
  onDone?: () => void;
  variant?: Variant;
  size?: Size;
  label?: string;
}) {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function run() {
    if (status === "running") return;
    setStatus("running");
    setMsg("");
    try {
      const res = await fetch("/api/portfolio/snapshots/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "Rebuild failed");
      setStatus("done");
      const days = json?.daysProcessed ?? 0;
      const gaps = json?.gapsFilledDays ?? 0;
      setMsg(
        `Rebuilt ${days} day${days === 1 ? "" : "s"}${gaps ? `, ${gaps} with gap-fills` : ""}.`,
      );
      onDone?.();
    } catch (e) {
      setStatus("error");
      setMsg(e instanceof Error ? e.message : "Rebuild failed");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant={variant} size={size} onClick={run} disabled={status === "running"}>
        <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${status === "running" ? "animate-spin" : ""}`} />
        {status === "running" ? "Rebuilding… (this may take a minute)" : label}
      </Button>
      {msg && (
        <span
          className={`text-xs ${
            status === "error" ? "text-rose-600" : "text-muted-foreground"
          }`}
        >
          {msg}
        </span>
      )}
    </div>
  );
}

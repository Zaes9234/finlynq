"use client";

/**
 * ModePicker — Reconciliation mode picker for the per-account settings panel
 * (Inbox v4 Phase 5, 2026-05-27).
 *
 * Surfaced inside the account detail page (/accounts/[id]). Three radio
 * options — Auto-pilot / Approve-each / Manual review — each carrying the
 * one-line sub-label + a gate-count badge. PATCHes /api/accounts/[id]/mode
 * when the user clicks Save; surfaces a small inline confirmation on
 * success so no full-page reload is needed.
 *
 * The lens-chip dropdown on /inbox links here via the gear icon. The chip
 * is throwaway; this picker is sticky (writes to accounts.mode).
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check } from "lucide-react";
import { MODES, MODE_ORDER, isMode, type Mode } from "./modes";

export function ModePicker({
  accountId,
  initialMode,
  onSaved,
}: {
  accountId: number;
  initialMode: Mode;
  onSaved?: (mode: Mode) => void;
}) {
  const [selected, setSelected] = useState<Mode>(initialMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks the last successfully-persisted mode so the Save button + the
  // success badge reset cleanly when the user picks a different option.
  const [savedMode, setSavedMode] = useState<Mode>(initialMode);

  const dirty = selected !== savedMode;

  async function onSave() {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}/mode`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: selected }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.success === false) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const newMode: Mode = isMode(body.data?.mode) ? body.data.mode : selected;
      setSavedMode(newMode);
      setSelected(newMode);
      onSaved?.(newMode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Reconciliation mode" className="space-y-2">
        {MODE_ORDER.map((m) => {
          const cfg = MODES[m];
          const Icon = cfg.icon;
          const isSelected = m === selected;
          const isCurrent = m === savedMode;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => setSelected(m)}
              className={`w-full text-left rounded-lg border p-3 transition-colors ${
                isSelected
                  ? "border-foreground/40 bg-muted/40"
                  : "hover:bg-muted/30"
              }`}
            >
              <div className="flex items-start gap-3">
                <span
                  className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    isSelected ? "border-foreground" : "border-muted-foreground/40"
                  }`}
                >
                  {isSelected && (
                    <span className="h-2 w-2 rounded-full bg-foreground" />
                  )}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Icon className={`h-4 w-4 ${cfg.tone.split(" ")[0]}`} />
                    <span className="text-sm font-medium">{cfg.label}</span>
                    <Badge
                      variant="outline"
                      className="text-[10px] font-mono"
                    >
                      {cfg.gates} {cfg.gates === 1 ? "gate" : "gates"}
                    </Badge>
                    {isCurrent && (
                      <Badge
                        variant="outline"
                        className="text-[10px] font-mono uppercase tracking-wider ml-auto"
                      >
                        current
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 ml-6">
                    {cfg.subLabel}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {error && (
        <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => void onSave()}
          disabled={!dirty || saving}
        >
          {saving ? "Saving…" : "Save mode"}
        </Button>
        {!dirty && savedMode === selected && !saving && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <Check className="h-3.5 w-3.5" />
            Saved
          </span>
        )}
      </div>
    </div>
  );
}

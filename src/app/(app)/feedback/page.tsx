"use client";

/**
 * /feedback — the user's own feedback threads. Lists their submissions with a
 * status + an unread "New reply" flag; opening a card shows the full thread
 * (original message + replies) with a reply box. Opening a thread marks it read
 * (POST /api/feedback/[id]/read) so the "Your feedback" nav badge clears.
 */

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { FeedbackDialog } from "@/components/feedback-dialog";
import type {
  FeedbackMessage,
  FeedbackThread,
  FeedbackThreadSummary,
} from "@shared/types";

const typeColor: Record<string, string> = {
  bug: "bg-destructive/15 text-destructive",
  idea: "bg-primary/15 text-primary",
  question: "bg-blue-500/15 text-blue-500",
  other: "bg-muted text-muted-foreground",
};

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function Bubble({
  side,
  label,
  at,
  body,
}: {
  side: "left" | "right";
  label: string;
  at: string;
  body: string;
}) {
  return (
    <div className={cn("flex flex-col", side === "right" ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
          side === "right" ? "bg-primary/10 text-foreground" : "bg-muted text-foreground",
        )}
      >
        {body}
      </div>
      <span className="mt-1 text-[10px] text-muted-foreground">
        {label} · {fmt(at)}
      </span>
    </div>
  );
}

function ThreadDialog({
  feedbackId,
  onClose,
}: {
  feedbackId: number | null;
  onClose: () => void;
}) {
  const [thread, setThread] = useState<FeedbackThread | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (feedbackId == null) {
      setThread(null);
      setReply("");
      setError(null);
      return;
    }
    let cancelled = false;
    setThread(null);
    setError(null);
    fetch(`/api/feedback/${feedbackId}`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load");
        return r.json();
      })
      .then((t: FeedbackThread) => {
        if (!cancelled) setThread(t);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load this thread.");
      });
    // Mark read so the nav badge clears on the next navigation.
    fetch(`/api/feedback/${feedbackId}/read`, { method: "POST" }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [feedbackId]);

  const send = async () => {
    const body = reply.trim();
    if (!body || feedbackId == null) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/feedback/${feedbackId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Failed to send reply.");
      }
      const msg: FeedbackMessage = await res.json();
      setThread((t) =>
        t ? { ...t, messages: [...t.messages, msg], messageCount: t.messageCount + 1 } : t,
      );
      setReply("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send reply.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={feedbackId != null} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="capitalize">
            {thread ? `${thread.type} feedback` : "Feedback"}
          </DialogTitle>
          <DialogDescription>
            Replies from the team appear here. Please don&apos;t include sensitive
            financial details.
          </DialogDescription>
        </DialogHeader>

        {error && !thread && <p className="text-sm text-destructive">{error}</p>}

        {thread && (
          <>
            <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
              <Bubble side="right" label="You" at={thread.createdAt} body={thread.seed} />
              {thread.messages.map((m) => (
                <Bubble
                  key={m.id}
                  side={m.authorRole === "user" ? "right" : "left"}
                  label={m.authorRole === "user" ? "You" : "Finlynq team"}
                  at={m.createdAt}
                  body={m.body}
                />
              ))}
            </div>
            <div className="space-y-2">
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={3}
                maxLength={4000}
                placeholder="Write a reply…"
                className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex justify-end">
                <Button onClick={send} disabled={sending || !reply.trim()}>
                  {sending ? "Sending…" : "Send reply"}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function FeedbackPage() {
  const [items, setItems] = useState<FeedbackThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [sendOpen, setSendOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/feedback");
      if (!res.ok) throw new Error("Failed to load");
      const list = await res.json();
      setItems(Array.isArray(list) ? list : []);
    } catch {
      setError("Failed to load your feedback.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your feedback</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Track your reports and follow up on replies from the team.
          </p>
        </div>
        <Button onClick={() => setSendOpen(true)}>Send feedback</Button>
      </div>

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {items && items.length === 0 && !error && (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          You haven&apos;t sent any feedback yet.
          <div className="mt-3">
            <Button onClick={() => setSendOpen(true)}>Send feedback</Button>
          </div>
        </Card>
      )}

      <div className="space-y-3">
        {items?.map((t) => (
          <Card
            key={t.id}
            onClick={() => setOpenId(t.id)}
            className="cursor-pointer p-4 transition-colors hover:bg-muted/40"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={typeColor[t.type] ?? typeColor.other}>{t.type}</Badge>
              <Badge variant="outline" className="capitalize">
                {t.status}
              </Badge>
              {t.unread && <Badge className="bg-primary/15 text-primary">New reply</Badge>}
              <span className="ml-auto text-xs text-muted-foreground">
                {fmt(t.lastMessageAt)}
              </span>
            </div>
            <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
              {t.lastMessagePreview}
            </p>
            {t.messageCount > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t.messageCount} {t.messageCount === 1 ? "reply" : "replies"}
              </p>
            )}
          </Card>
        ))}
      </div>

      <ThreadDialog
        feedbackId={openId}
        onClose={() => {
          setOpenId(null);
          load();
        }}
      />
      <FeedbackDialog
        open={sendOpen}
        onOpenChange={(v) => {
          setSendOpen(v);
          if (!v) load();
        }}
      />
    </div>
  );
}

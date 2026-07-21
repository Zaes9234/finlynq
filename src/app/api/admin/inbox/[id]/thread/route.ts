/**
 * GET /api/admin/inbox/[id]/thread — the full conversation for an inbox email.
 *
 * Groups the opened email with its thread siblings (other incoming_emails from
 * the SAME external party with the same normalized subject) and every reply we
 * sent (incoming_email_replies linked to any thread email), returned as one
 * chronological message list so /admin/inbox can render the back-and-forth and
 * the maintainer can see + continue a thread. Admin-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, inArray, sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";

export const dynamic = "force-dynamic";

/** Strip leading Re:/Fwd:/Fw: (repeated) and normalize for thread matching. */
function normSubject(s: string | null | undefined): string {
  let t = (s ?? "").trim();
  // Drop the literal "Subject:" prefix some senders include, then Re:/Fwd:.
  t = t.replace(/^\s*subject:\s*/i, "");
  while (/^\s*(re|fwd|fw)\s*:\s*/i.test(t)) {
    t = t.replace(/^\s*(re|fwd|fw)\s*:\s*/i, "");
  }
  return t.trim().toLowerCase();
}

export interface ThreadMessage {
  kind: "inbound" | "outbound";
  id: string;
  fromAddress: string;
  toAddress: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  at: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;
  const { id } = await params;

  const opened = await db
    .select()
    .from(schema.incomingEmails)
    .where(eq(schema.incomingEmails.id, id))
    .get();

  if (!opened) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const key = normSubject(opened.subject);
  const party = (opened.fromAddress || "").toLowerCase();

  // Thread inbound = same external party, same normalized subject.
  const candidates = await db
    .select()
    .from(schema.incomingEmails)
    .where(sql`lower(${schema.incomingEmails.fromAddress}) = ${party}`)
    .all();
  const inbound = candidates.filter((r) => normSubject(r.subject) === key);
  // Always include the opened row even if a subject quirk excludes it.
  if (!inbound.some((r) => r.id === opened.id)) inbound.push(opened);

  const inboundIds = inbound.map((r) => r.id);
  const replies = inboundIds.length
    ? await db
        .select()
        .from(schema.incomingEmailReplies)
        .where(inArray(schema.incomingEmailReplies.incomingEmailId, inboundIds))
        .all()
    : [];

  const messages: ThreadMessage[] = [
    ...inbound.map((r) => ({
      kind: "inbound" as const,
      id: r.id,
      fromAddress: r.fromAddress,
      toAddress: r.toAddress,
      subject: r.subject,
      bodyText: r.bodyText,
      bodyHtml: r.bodyHtml,
      at: (r.receivedAt as unknown as Date | string)?.toString?.() ?? String(r.receivedAt),
    })),
    ...replies.map((r) => ({
      kind: "outbound" as const,
      id: r.id,
      fromAddress: r.fromAddress,
      toAddress: r.toAddress,
      subject: r.subject,
      bodyText: r.body,
      bodyHtml: null,
      at: (r.sentAt as unknown as Date | string)?.toString?.() ?? String(r.sentAt),
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return NextResponse.json({
    id: opened.id,
    category: opened.category,
    subject: opened.subject,
    counterparty: opened.fromAddress,
    triagedAt: opened.triagedAt,
    messages,
  });
}

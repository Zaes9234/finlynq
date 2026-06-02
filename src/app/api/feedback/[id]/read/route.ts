/**
 * POST /api/feedback/[id]/read — mark the user's feedback thread read up to now.
 *
 * Sets feedback.user_last_read_at = NOW() for the owning user. Idempotent.
 * Clears the "Your feedback" nav badge on the next navigation (the nav refetches
 * GET /api/feedback per pathname change). Mirrors POST /api/announcements/[id]/read.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const feedbackId = Number((await params).id);
  if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  await db
    .update(schema.feedback)
    .set({ userLastReadAt: new Date() })
    .where(
      and(eq(schema.feedback.id, feedbackId), eq(schema.feedback.userId, userId)),
    );

  return NextResponse.json({ ok: true });
}

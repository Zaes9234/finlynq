/**
 * POST /api/feedback/[id]/reply — the user posts a follow-up on their own
 * feedback thread.
 *
 * Ownership-checked (404 on a non-owned id). Rate-limited on a DISTINCT bucket
 * (`feedback-reply:`) so replies don't starve the submit bucket (`feedback:`).
 * Inserts a feedback_messages row (author_role='user'), bumps feedback.updated_at
 * and the author's own user_last_read_at. In-app only — no email.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";
import { toFeedbackMessage } from "@/lib/feedback/thread";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  body: z.string().trim().min(1, "Message is required").max(4000),
});

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

  // Distinct bucket from the submit limiter: 30 replies/hour.
  const rl = checkRateLimit(`feedback-reply:${userId}`, 30, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many replies. Please try again later." },
      { status: 429 },
    );
  }

  try {
    const parsed = validateBody(await request.json(), bodySchema);
    if (parsed.error) return parsed.error;

    // Ownership — 404 (not 403) on a stranger's id.
    const [fb] = await db
      .select({ id: schema.feedback.id })
      .from(schema.feedback)
      .where(
        and(eq(schema.feedback.id, feedbackId), eq(schema.feedback.userId, userId)),
      );
    if (!fb) return NextResponse.json({ error: "Not found." }, { status: 404 });

    const now = new Date();
    const [msg] = await db
      .insert(schema.feedbackMessages)
      .values({
        feedbackId,
        authorRole: "user",
        authorId: userId,
        body: parsed.data.body,
        createdAt: now,
      })
      .returning();
    await db
      .update(schema.feedback)
      .set({ updatedAt: now, userLastReadAt: now })
      .where(eq(schema.feedback.id, feedbackId));

    return NextResponse.json(toFeedbackMessage(msg, userId), { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e, "Failed to send reply.") },
      { status: 500 },
    );
  }
}

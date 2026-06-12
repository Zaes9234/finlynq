/**
 * POST /api/feedback — submit in-app feedback (bug report / idea / question).
 *
 * Any authenticated user. The DB row is the source of truth (reviewable at
 * /admin/feedback); a maintainer email notification is fire-and-forget so a
 * missing SMTP config never 500s the submit. Rate-limited per user.
 *
 * Feedback is stored PLAINTEXT (see schema-pg.ts) — it must be readable by the
 * maintainer, and the user's per-user DEK is unreadable by an admin.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/db";
import { desc, eq, inArray } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendEmail, feedbackNotificationEmail } from "@/lib/email";
import { getUserById } from "@/lib/auth/queries";
import { buildThreadSummary } from "@/lib/feedback/thread";
import type { FeedbackThreadSummary } from "@shared/types";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  type: z.enum(["bug", "idea", "question", "other"]),
  message: z.string().trim().min(1, "Message is required").max(4000),
  pageUrl: z.string().max(500).optional(),
  appVersion: z.string().max(50).optional(),
});

// Best-effort maintainer notification — resolve a friendly user label, then
// fire the email. Any failure (no SMTP, DB hiccup) is swallowed by the caller.
async function notifyMaintainer(
  userId: string,
  d: z.infer<typeof bodySchema>,
): Promise<void> {
  let userLabel: string | null = null;
  try {
    const user = await getUserById(userId);
    userLabel = user?.username || user?.email || null;
  } catch {
    /* fall back to userId in the template */
  }
  await sendEmail(
    feedbackNotificationEmail({
      feedbackType: d.type,
      message: d.message,
      userId,
      userLabel,
      pageUrl: d.pageUrl ?? null,
      appVersion: d.appVersion ?? null,
    }),
  );
}

// GET /api/feedback — the current user's feedback threads (summaries with an
// `unread` flag driving the nav badge). Bare JSON array, mirroring
// GET /api/announcements so the nav + mobile client consume it unchanged.
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const fbRows = await db
    .select({
      id: schema.feedback.id,
      type: schema.feedback.type,
      status: schema.feedback.status,
      message: schema.feedback.message,
      userLastReadAt: schema.feedback.userLastReadAt,
      adminLastReadAt: schema.feedback.adminLastReadAt,
      createdAt: schema.feedback.createdAt,
      updatedAt: schema.feedback.updatedAt,
    })
    .from(schema.feedback)
    .where(eq(schema.feedback.userId, userId))
    .orderBy(desc(schema.feedback.updatedAt));

  const ids = fbRows.map((r) => r.id);
  const msgs = ids.length
    ? await db
        .select()
        .from(schema.feedbackMessages)
        .where(inArray(schema.feedbackMessages.feedbackId, ids))
    : [];
  const byThread = new Map<number, typeof msgs>();
  for (const m of msgs) {
    const arr = byThread.get(m.feedbackId) ?? [];
    arr.push(m);
    byThread.set(m.feedbackId, arr);
  }

  const data: FeedbackThreadSummary[] = fbRows.map((fb) =>
    buildThreadSummary(fb, byThread.get(fb.id) ?? [], "user"),
  );
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  // Per-user rate limit: 10 submissions per hour.
  const rl = checkRateLimit(`feedback:${userId}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many submissions. Please try again later." },
      { status: 429 },
    );
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, bodySchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;

    const [row] = await db
      .insert(schema.feedback)
      .values({
        userId,
        type: d.type,
        message: d.message,
        pageUrl: d.pageUrl ?? null,
        appVersion: d.appVersion ?? "web",
      })
      .returning({ id: schema.feedback.id });

    // Fire-and-forget: never block the response or 500 on email failure.
    void notifyMaintainer(userId, d).catch((err) => {

      console.error("[feedback-email] notify failed", err);
    });

    return NextResponse.json({ ok: true, id: row.id }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e, "Failed to submit feedback.") },
      { status: 500 },
    );
  }
}

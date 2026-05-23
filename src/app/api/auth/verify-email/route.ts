/**
 * GET /api/auth/verify-email?token=... — Verify email address.
 *
 * Managed edition only. Marks the user's email as verified and redirects to
 * the dashboard.
 *
 * Finding M-19 (2026-05-07) — open-redirect hardening. Previously the
 * redirect target was built directly from `process.env.APP_URL`. A
 * misconfigured or environment-injected `APP_URL` would turn this into an
 * open redirect by way of an emailed verification link. We now anchor the
 * redirect on the request's actual origin and don't trust `APP_URL` at all.
 *
 * Behind a reverse proxy (Caddy → systemd-bound 0.0.0.0:3456 on prod), we
 * must read the public origin from the X-Forwarded-* headers Caddy sets,
 * NOT from `request.nextUrl.origin` which resolves to the upstream
 * 0.0.0.0:3456 form and produces a Location header the browser rejects
 * with ERR_ADDRESS_INVALID. Mirrors the pattern fixed in /try-demo
 * (commit 0c8f0b4).
 */

import { NextRequest, NextResponse } from "next/server";
import { getDialect } from "@/db";
import { verifyUserEmail } from "@/lib/auth/queries";

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Email verification is only available in managed mode." },
      { status: 403 }
    );
  }

  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return NextResponse.json(
      { error: "Missing verification token." },
      { status: 400 }
    );
  }

  const user = await verifyUserEmail(token);
  if (!user) {
    return NextResponse.json(
      { error: "Invalid or expired verification token." },
      { status: 400 }
    );
  }

  // Build the absolute redirect URL from the X-Forwarded-* headers Caddy
  // sets, NOT from request.nextUrl.origin. Behind the reverse proxy the
  // upstream origin is the systemd-bound 0.0.0.0:3456 form, so using
  // nextUrl.origin produces a Location header that breaks in the browser
  // ("ERR_ADDRESS_INVALID"). Forwarded-host headers carry the original
  // public origin (finlynq.com) and are the standard pattern for routes
  // behind a reverse proxy.
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const host = forwardedHost ?? request.nextUrl.host;
  const proto =
    forwardedProto ?? request.nextUrl.protocol.replace(/:$/, "");
  return NextResponse.redirect(`${proto}://${host}/dashboard?emailVerified=1`);
}

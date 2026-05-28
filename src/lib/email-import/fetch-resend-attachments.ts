/**
 * Fetch Resend Inbound attachment bytes via the Resend HTTP API.
 *
 * Resend's `email.received` webhook payload does NOT inline attachment bytes —
 * only the email metadata. To get the file contents we have to:
 *   1. Hit GET /received-emails/{id}/attachments  → list of {id, filename, downloadUrl}
 *   2. Fetch each `downloadUrl` (signed, time-limited)
 *   3. Base64-encode the bytes back into the `ResendAttachment` shape so the
 *      existing `parseResendAttachments` consumer doesn't change.
 *
 * Returns [] (with a warn log) when RESEND_API_KEY is missing or any HTTP
 * step fails, so the webhook handler degrades gracefully to its "no
 * importable attachments" trash classification rather than 500-ing.
 *
 * Why a separate helper:
 *   - Keeps `route.ts` linear (verify → parse payload → route → import|mailbox|trash).
 *   - The Resend API is well-documented and call-shape-stable enough to test in
 *     isolation; the route handler isn't.
 *   - Pre-existing `parseResendAttachments(...)` already accepts our shape and
 *     handles CSV/PDF/Excel — nothing else needs to change to get the rows
 *     flowing through to `stageEmailImport`.
 */

import type { ResendAttachment } from "./parse-attachments";

interface AttachmentListItem {
  id?: string;
  filename?: string;
  content_type?: string;
  contentType?: string;
  size?: number;
  download_url?: string;
  downloadUrl?: string;
}

interface AttachmentListResponse {
  data?: AttachmentListItem[];
  object?: string;
}

const RESEND_API_BASE = "https://api.resend.com";

export async function fetchResendAttachments(
  resendEmailId: string,
): Promise<ResendAttachment[]> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      `[email-webhook] RESEND_API_KEY not set — cannot fetch attachments for ${resendEmailId}`,
    );
    return [];
  }

  let listResp: Response;
  try {
    listResp = await fetch(
      `${RESEND_API_BASE}/received-emails/${encodeURIComponent(resendEmailId)}/attachments`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
  } catch (e) {
    console.warn(`[email-webhook] list-attachments network error for ${resendEmailId}:`, e);
    return [];
  }

  if (!listResp.ok) {
    console.warn(
      `[email-webhook] list-attachments returned HTTP ${listResp.status} for ${resendEmailId}`,
    );
    return [];
  }

  let parsed: AttachmentListResponse | AttachmentListItem[];
  try {
    parsed = (await listResp.json()) as AttachmentListResponse | AttachmentListItem[];
  } catch (e) {
    console.warn(`[email-webhook] list-attachments JSON parse error for ${resendEmailId}:`, e);
    return [];
  }

  const items: AttachmentListItem[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.data)
      ? parsed.data
      : [];

  if (items.length === 0) return [];

  const out: ResendAttachment[] = [];
  for (const item of items) {
    const url = item.download_url ?? item.downloadUrl;
    const filename = item.filename;
    if (!url || !filename) {
      console.warn(
        `[email-webhook] attachment ${item.id ?? "?"} missing url or filename — skipping`,
      );
      continue;
    }

    let bytesResp: Response;
    try {
      bytesResp = await fetch(url);
    } catch (e) {
      console.warn(`[email-webhook] attachment ${item.id ?? filename} download error:`, e);
      continue;
    }

    if (!bytesResp.ok) {
      console.warn(
        `[email-webhook] attachment ${item.id ?? filename} download HTTP ${bytesResp.status}`,
      );
      continue;
    }

    try {
      const buf = Buffer.from(await bytesResp.arrayBuffer());
      out.push({
        filename,
        contentType: item.content_type ?? item.contentType,
        content: buf.toString("base64"),
      });
    } catch (e) {
      console.warn(`[email-webhook] attachment ${item.id ?? filename} buffer error:`, e);
    }
  }

  return out;
}

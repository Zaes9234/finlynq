/**
 * /settings/securities — folded into /settings/investments.
 *
 * The securities-master management UI (list each security once, rename, link/
 * unlink accounts) was merged into the unified Investments page (one row per
 * security, filterable). This route redirects so existing deep-links keep
 * working. The /api/securities endpoints are unchanged.
 */

import { redirect } from "next/navigation";

export default function SecuritiesRedirect() {
  redirect("/settings/investments");
}

/**
 * /settings/holding-accounts — folded into /settings/investments.
 *
 * The Holding ↔ Account Map was consolidated into the unified securities-grained
 * Investments page; linking a security to a specific account now happens in the
 * transaction / portfolio-entry flow. This route redirects so existing
 * deep-links / bookmarks keep working. The many-to-many `holding_accounts` join
 * table + its /api/holding-accounts endpoints are unchanged.
 */

import { redirect } from "next/navigation";

export default function HoldingAccountsRedirect() {
  redirect("/settings/investments");
}

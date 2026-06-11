import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";

/**
 * Cron authentication — shared, fail-closed CRON_SECRET bearer check.
 *
 * Returns true iff the request carries a valid `Authorization: Bearer
 * <CRON_SECRET>` header. FAIL-CLOSED: if CRON_SECRET is unset, ALWAYS returns
 * false — an unauthenticated cron run is never allowed (B9-F08; replaces the
 * per-route checks, two of which — refresh-pricing, send-followups — failed
 * OPEN when the secret was unset, and four of which compared against the
 * literal string "Bearer undefined" when unset).
 *
 * Constant-time comparison mirrors the codebase's existing secret-check
 * convention (auth/admin-password, slack/verify-signature).
 */
export function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization");
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(header, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

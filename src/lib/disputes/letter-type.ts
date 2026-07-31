/**
 * letter-type — THE resolver from a stored dispute row to its letter template.
 *
 * Single source (S298). Until this module, three private copies lived in the
 * [disputeId] GET, the redraft route, and the timeline projector — and the
 * first two had ALREADY drifted: on legacy rows (no metadata.letterType) the
 * GET mapped `complaint → balance_billing` / default → overcharge while
 * redraft mapped `complaint → overcharge` / default → insurance_appeal, so a
 * legacy complaint letter would change template on redraft. Dead code on
 * current data (every row since ~S109 stamps metadata.letterType at persist;
 * 0 unstamped rows in the DEV corpus) — but exactly the drift consolidation
 * exists to kill.
 *
 * Corrected here (Andrew, S298): legacy `external_appeal → external_review`.
 * The old GET guess (`insurance_appeal`) mistook the insurer track's TERMINAL
 * letter for its first rung — a denied legacy external review would be
 * offered "Start the next letter — external review", an escalation to the
 * letter it already is.
 *
 * Source of truth (newer rows): metadata.letterType, stamped at persist.
 * Legacy fallback: dispute_type → letter type, GET semantics + the fix.
 */
import type { DisputeLetterType } from "@/lib/billing/types";

export function resolveLetterTypeFromDispute(dispute: {
  dispute_type: string;
  metadata?: Record<string, unknown> | null;
}): DisputeLetterType {
  const metaType =
    dispute.metadata && typeof dispute.metadata === "object"
      ? (dispute.metadata as { letterType?: string }).letterType
      : undefined;
  if (metaType) return metaType as DisputeLetterType;
  switch (dispute.dispute_type) {
    case "internal_appeal":
      return "insurance_appeal";
    case "negotiation":
      return "negotiation";
    case "complaint":
      return "balance_billing";
    case "external_appeal":
      return "external_review";
    default:
      return "overcharge";
  }
}

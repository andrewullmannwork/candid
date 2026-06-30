/**
 * Dispute letter re-render helper (Phase 7)
 *
 * Called from /api/disputes/[disputeId] when the planContext fingerprint
 * changes (e.g., the user uploaded a matching-year plan after drafting the
 * letter). Rebuilds the letter body using the current plan context + evidence
 * and returns the new body string. The caller persists it to
 * dispute_outcomes.letter_content.
 *
 * Intentionally lightweight: we already have the plan context + evidence
 * passed in; this only composes the new body via templates.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DisputeLetterType, AuditReport } from "@/lib/billing/types";
import type { PlanContext } from "./plan-context";
import type { DisputeEvidence } from "./evidence-resolver";
import { LETTER_TEMPLATES } from "./templates";
import { letterRecipientKind } from "./index";
import { resolveLetterRecovery } from "./dispute-grounds";
import { loadDisputeGroundBasis } from "./dispute-ground-basis";
import { isFeatureEnabled } from "@/lib/config/product-flags";

interface RerenderParams {
  disputeId: string;
  userId: string;
  letterType: DisputeLetterType;
  claimId: string;
  lineItemIds: string[];
  planContext: PlanContext | null;
  evidence: DisputeEvidence | null;
  /**
   * Block C2 (item 1) — the name the user adopted when attesting
   * (dispute.metadata.attestingAsName). Passed from the [disputeId] GET (which
   * reads dispute.metadata). Flows into String 2 + the request block; the
   * templates fall back to patientName when absent.
   */
  attestingName?: string;
}

/** §18 incr-4 — the re-rendered body plus the deductible-aware recovery summary (present
 *  only on the dispute_grounds_v1 path) so callers can FLOAT amount_disputed on rebuild and
 *  surface the §18.10.D "confirm to strengthen" prompt. */
export interface RerenderResult {
  body: string;
  recovery: {
    total: number;
    weakened: boolean;
    strengthenableFields: Array<"deductible" | "oop" | "network">;
  } | null;
}

export async function rerenderDisputeLetter(
  supabase: SupabaseClient,
  params: RerenderParams,
): Promise<RerenderResult | null> {
  const { userId, letterType, claimId, planContext, evidence } = params;

  const template = LETTER_TEMPLATES[letterType];
  if (!template) return null;

  // Block C2 item 4 — load the v3 flag once: it both enforces the Block A
  // data-trust HARD STOP and switches the body into the conditional request tree
  // (passed to template.body below). OFF → legacy letter, byte-identical.
  const v3DesignOn = await isFeatureEnabled("dispute_letter_v3_design");

  // §18 incr-3 — when ON, the 3 provider templates source their finding block from
  // `evidence` (passed below) instead of the AuditReport findings, which this path sets to
  // [] → the $0.00 refresh bug. OFF → byte-identical (renders findings: []). THIS is the
  // path the bug lives on: rerender re-derives the body with no findings.
  const disputeGroundsOn = await isFeatureEnabled("dispute_grounds_v1");

  // Block A — data-trust HARD STOP (flag-gated). Symmetric with
  // generateDisputeLetter: a header-reconciliation failure suppresses
  // regeneration so the [disputeId] GET serves no letter (it surfaces the
  // banner instead). Default OFF → status quo. See §1a / legal L3.
  if (evidence?.dataTrust?.headerReconciliationFailed && v3DesignOn) {
    return null;
  }

  // Hydrate a minimal ParsedBill so templates can read patient + provider,
  // and pull the user's display name as a fallback when the bill metadata's
  // patient name is missing, placeholder-looking, or mis-OCR'd.
  // Source of truth for the user's name is `users.display_name` (per
  // migration 001). `profiles` does not store name fields. Email is used
  // as a last resort.
  const [{ data: claim }, { data: userRow }] = await Promise.all([
    supabase
      .from("claims")
      .select("metadata, date_of_service, total_billed")
      .eq("id", claimId)
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("users")
      .select("display_name, email")
      .eq("id", userId)
      .maybeSingle(),
  ]);
  if (!claim) return null;

  const metadata = (claim.metadata as {
    patient?: { name?: string; memberId?: string };
    provider?: { name?: string; address?: string };
    insurer?: { name?: string };
    billType?: string;
  }) ?? {};

  const profileName = resolveAccountName(userRow?.display_name, userRow?.email);
  const patientName = pickPatientName(metadata.patient?.name, profileName);

  const bill = {
    patient: {
      name: patientName,
      memberId: metadata.patient?.memberId ?? undefined,
    },
    provider: {
      name: metadata.provider?.name ?? "",
      address: metadata.provider?.address,
    },
    insurer: metadata.insurer ? { name: metadata.insurer.name ?? "" } : undefined,
    serviceDate: claim.date_of_service ?? "",
    billType: metadata.billType ?? "eob",
    lineItems: [],
    totals: { totalBilled: Number(claim.total_billed ?? 0) },
  } as unknown as AuditReport["parsedBill"];

  // Phase 4 Task 4-E: gate blockquote rendering on Pattern P-8 cite-grade
  // verification when consumer_read_filter_v1 is ON. Re-render path always
  // honors current flag state — when flag flips ON post-draft, regenerated
  // letter applies the gating; when flag flips OFF, letter goes back to
  // legacy unconditional rendering. Symmetric with /api/disputes/generate.
  const gateUnverified = await isFeatureEnabled("consumer_read_filter_v1");
  // dispute_noplan_coverage_request_v1 — symmetric with generate; reframe the coverage ask
  // to a plan-document + adjudication request when no plan is on file. OFF → byte-identical.
  const noPlanCoverageRequestOn = await isFeatureEnabled("dispute_noplan_coverage_request_v1");

  // §18 incr-4 — the per-line deductible-aware letter dollars (== the card recovery), gated on
  // the flag. A user-triggered redraft re-resolves the basis FRESH, so any cost-share overrides
  // the user just supplied (deductible/OOP/network) flow into a STRONGER letter on rebuild. OFF →
  // undefined → byte-identical legacy (discrepancyAmount) rendering. SYMMETRIC with generate so
  // the two paths can't diverge on the dollar.
  const recovery =
    disputeGroundsOn && evidence
      ? resolveLetterRecovery(evidence, await loadDisputeGroundBasis(supabase, userId, [claimId]), letterRecipientKind(letterType))
      : null;
  const letterRecovery = recovery?.byLine;

  const body = template.body({
    patientName: bill.patient.name ?? "",
    providerName: bill.provider.name ?? "",
    serviceDate: bill.serviceDate ?? "",
    findings: [],
    bill,
    planContext,
    evidence,
    gateUnverified,
    v3DesignOn,
    disputeGroundsOn,
    attestingName: params.attestingName,
    letterRecovery,
    recovery: recovery ?? undefined,
    noPlanCoverageRequestOn,
  });

  return {
    body,
    recovery: recovery
      ? { total: recovery.total, weakened: recovery.weakened, strengthenableFields: recovery.strengthenableFields }
      : null,
  };
}

// Default to the account holder's name (from users.display_name); fall back
// to bill-parsed name only when account name is unavailable. The UI surfaces
// a banner when these differ so the user can edit before sending.
function pickPatientName(billName: string | null | undefined, profileName: string): string {
  if (profileName) return profileName;
  const trimmed = (billName ?? "").trim();
  if (!trimmed) return "";
  if (/^(patient|member|subscriber|insured|name)$/i.test(trimmed)) return "";
  if (/^\[.+\]$/.test(trimmed)) return "";
  return trimmed;
}

// Best-effort name resolution from users.display_name, with an email-derived
// fallback. Email like "andrew.david.ullmann@gmail.com" → "Andrew Ullmann"
// (first + last token, dropping middle "david").
export function resolveAccountName(
  displayName: string | null | undefined,
  email: string | null | undefined,
): string {
  const dn = (displayName ?? "").trim();
  if (dn) return dn;

  const local = (email ?? "").split("@")[0]?.trim();
  if (!local) return "";
  const tokens = local
    .split(/[._\-+]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !/^\d+$/.test(t))
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());

  if (tokens.length === 0) return "";
  if (tokens.length === 1) return tokens[0];
  // first token + last token; drop middle (e.g., "andrew.david.ullmann"
  // becomes "Andrew Ullmann").
  return `${tokens[0]} ${tokens[tokens.length - 1]}`;
}

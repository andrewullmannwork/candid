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
import { isFeatureEnabled } from "@/lib/config/product-flags";

interface RerenderParams {
  disputeId: string;
  userId: string;
  letterType: DisputeLetterType;
  claimId: string;
  lineItemIds: string[];
  planContext: PlanContext | null;
  evidence: DisputeEvidence | null;
}

export async function rerenderDisputeLetter(
  supabase: SupabaseClient,
  params: RerenderParams,
): Promise<string | null> {
  const { userId, letterType, claimId, planContext, evidence } = params;

  const template = LETTER_TEMPLATES[letterType];
  if (!template) return null;

  // Block A — data-trust HARD STOP (flag-gated). Symmetric with
  // generateDisputeLetter: a header-reconciliation failure suppresses
  // regeneration so the [disputeId] GET serves no letter (it surfaces the
  // banner instead). Flag read only when recon actually failed (cheap). Default
  // OFF → status quo. See plans/dispute_letter_overhaul.md §1a / legal L3.
  if (evidence?.dataTrust?.headerReconciliationFailed) {
    const enforceGate = await isFeatureEnabled("dispute_letter_v3_design");
    if (enforceGate) return null;
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

  const body = template.body({
    patientName: bill.patient.name ?? "",
    providerName: bill.provider.name ?? "",
    serviceDate: bill.serviceDate ?? "",
    findings: [],
    bill,
    planContext,
    evidence,
    gateUnverified,
  });

  return body;
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

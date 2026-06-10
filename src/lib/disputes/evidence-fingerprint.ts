// S74.5 D16 — Evidence fingerprint helper for dispute auto-refresh.
//
// Per plans/s74.5_categorization_flywheel.md v2 §7.5 + G2/Q-F/Q-I/Q-M LOCK.
//
// Computes a sha256 fingerprint over the audit evidence that informed a
// dispute letter: findings (type + slug + amount), line item slugs, and the
// total recovery estimate. Compare stored fingerprint vs current at view
// time to detect drift after category corrections.

import * as crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditFinding } from "../billing/types";
import { userScoped, selectOwnedChildren } from "@/lib/security/user-scoped";

interface LineItemSlugInput {
  service_slug: string | null;
  line_number?: number;
}

export interface FingerprintInput {
  findings: Array<Pick<AuditFinding, "type"> & { slug?: string | null; amount?: number }>;
  lineItems: LineItemSlugInput[];
  totalRecoveryEstimate: number;
}

/**
 * Load the FingerprintInput shape from a persisted claim. Reads
 * claim_line_items (service_slug + metadata.auditFindings) plus
 * claim.metadata.auditSummary.totalEstimatedOvercharge.
 *
 * Returns null if the claim or line items can't be loaded.
 */
export async function loadFingerprintInputForClaim(
  supabase: SupabaseClient,
  claimId: string,
  userId: string,
): Promise<FingerprintInput | null> {
  // B9-F12 — claimId is caller/request-supplied (disputes/generate passes
  // body.claimId; outcome / [disputeId] pass a dispute's claim_id, which a Pro
  // user could have smuggled in foreign since persist doesn't validate claim
  // ownership). Scope both reads to the authenticated user via the B1 layer:
  // a foreign claimId yields no claim → null (no fingerprint, no cross-tenant
  // read). createServerClient bypasses RLS, so this app-layer scope enforces it.
  const { data: claim } = await userScoped(supabase, userId)
    .table("claims")
    .select("id, metadata")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) return null;

  // selectOwnedChildren scopes line items to the owned claim; re-apply the
  // line_number order the prior `.order(...)` provided (the fingerprint hash
  // sorts internally, so this is belt-and-suspenders for op-equivalence).
  const lineItems = (
    await selectOwnedChildren(
      supabase,
      userId,
      "claim_line_items",
      [claimId],
      "line_number, service_slug, metadata",
    )
  ).sort((a, b) => (a.line_number ?? 0) - (b.line_number ?? 0));

  const claimMeta = (claim.metadata as Record<string, unknown> | null) ?? {};
  const auditSummary =
    (claimMeta.auditSummary as
      | {
          totalEstimatedOvercharge?: number;
          claimLevelFindings?: Array<{
            type?: string;
            estimatedOvercharge?: number;
            dismissed?: boolean;
          }>;
        }
      | undefined) ?? null;
  const totalRecoveryEstimate = Number(
    auditSummary?.totalEstimatedOvercharge ?? 0,
  );

  // S74.5c §2.5 + §1.7 + §2.7 — flatten findings from BOTH per-line metadata
  // and claim-level metadata. Filter out dismissed findings (§2.5) so a
  // dispute letter regenerates when the user signals "this evidence isn't
  // real." Dedup by kind-prefixed (kind, type, slug, amount) — C-9 fix
  // prevents a slug-less line-level finding from colliding with a
  // structurally-identical claim-level finding (both would compute the same
  // bare `type||amount` key; the "line" / "claim" prefix disambiguates them).
  type FindingShape = {
    type?: string;
    estimatedOvercharge?: number;
    dismissed?: boolean;
  };
  const findings: FingerprintInput["findings"] = [];
  const seen = new Set<string>();

  for (const li of lineItems ?? []) {
    const liMeta = (li.metadata as Record<string, unknown> | null) ?? {};
    const items =
      (liMeta.auditFindings as FindingShape[] | undefined) ?? [];
    for (const f of items) {
      if (f.dismissed) continue;
      const type = f.type ?? "unknown";
      const slug = (li.service_slug as string | null) ?? null;
      const amount = Number(f.estimatedOvercharge ?? 0);
      const key = `line|${type}|${slug ?? ""}|${amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ type: type as AuditFinding["type"], slug, amount });
    }
  }

  // §1.7 — claim-level findings (D15 unallocated_balance + future claim-header
  // findings). slug=null since they don't attach to any single line.
  const claimLevel = auditSummary?.claimLevelFindings ?? [];
  for (const f of claimLevel) {
    if (f.dismissed) continue;
    const type = f.type ?? "unknown";
    const amount = Number(f.estimatedOvercharge ?? 0);
    const key = `claim|${type}|${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ type: type as AuditFinding["type"], slug: null, amount });
  }

  return {
    findings,
    lineItems: (lineItems ?? []).map((li) => ({
      service_slug: (li.service_slug as string | null) ?? null,
      line_number: li.line_number as number,
    })),
    totalRecoveryEstimate,
  };
}

export function computeEvidenceFingerprint(input: FingerprintInput): string {
  const canonical = {
    findings: input.findings
      .map((f) => ({
        type: f.type,
        slug: f.slug ?? null,
        amount: typeof f.amount === "number" ? Math.round(f.amount * 100) : null,
      }))
      .sort((a, b) => {
        const t = a.type.localeCompare(b.type);
        if (t !== 0) return t;
        return (a.slug ?? "").localeCompare(b.slug ?? "");
      }),
    line_item_slugs: input.lineItems
      .map((li) => li.service_slug ?? null)
      .sort((a, b) => (a ?? "").localeCompare(b ?? "")),
    total_recovery_cents: Math.round(input.totalRecoveryEstimate * 100),
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

/**
 * Compute cooldown_until value to write at Mark-as-Sent.
 * Defaults to 30 days per Q-M LOCK; configurable via flag in future.
 */
export function computeCooldownUntil(sentAt: Date, days: number = 30): Date {
  return new Date(sentAt.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Decision shape for the view endpoint: should we refresh the letter, show a
 * drift banner, or serve cached?
 */
export type DriftDecision =
  | { action: "serve_cached" }
  | { action: "regenerate_draft"; reason: "fingerprint_mismatch" }
  | {
      action: "show_drift_banner_for_sent";
      cooldownActive: boolean;
      cooldownUntil: Date | null;
    }
  | { action: "serve_cached_within_debounce"; debounceSecondsRemaining: number };

export function decideDriftAction(opts: {
  storedFingerprint: string | null;
  currentFingerprint: string;
  sentAt: Date | null;
  cooldownUntil: Date | null;
  lastRefreshAt: Date | null;
  debounceMinutes?: number;
}): DriftDecision {
  const debounceMs = (opts.debounceMinutes ?? 5) * 60 * 1000;
  const isMatch = opts.storedFingerprint === opts.currentFingerprint;

  if (isMatch) return { action: "serve_cached" };

  // Mismatch path
  if (opts.sentAt) {
    const now = Date.now();
    const cooldownActive = opts.cooldownUntil
      ? now < opts.cooldownUntil.getTime()
      : false;
    return {
      action: "show_drift_banner_for_sent",
      cooldownActive,
      cooldownUntil: opts.cooldownUntil,
    };
  }

  // Mismatch + draft: debounce regenerate
  if (opts.lastRefreshAt) {
    const elapsed = Date.now() - opts.lastRefreshAt.getTime();
    if (elapsed < debounceMs) {
      return {
        action: "serve_cached_within_debounce",
        debounceSecondsRemaining: Math.ceil((debounceMs - elapsed) / 1000),
      };
    }
  }

  return { action: "regenerate_draft", reason: "fingerprint_mismatch" };
}

// S74.5 D16 — Evidence fingerprint helper for dispute auto-refresh.
//
// Per plans/s74.5_categorization_flywheel.md v2 §7.5 + G2/Q-F/Q-I/Q-M LOCK.
//
// Computes a sha256 fingerprint over the audit evidence that informed a
// dispute letter: findings (type + slug + amount), line item slugs, and the
// total recovery estimate. Compare stored fingerprint vs current at view
// time to detect drift after category corrections.

import * as crypto from "crypto";
import type { AuditFinding } from "../billing/types";

interface LineItemSlugInput {
  service_slug: string | null;
  line_number?: number;
}

interface FingerprintInput {
  findings: Array<Pick<AuditFinding, "type"> & { slug?: string | null; amount?: number }>;
  lineItems: LineItemSlugInput[];
  totalRecoveryEstimate: number;
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
      .filter((s): s is string | null => true)
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

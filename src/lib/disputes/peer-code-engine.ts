/**
 * S74.6 D5 — Peer-code engine for dispute-letter alternative-code recommendations.
 *
 * When generating a dispute letter for a denied line, surface the slug's known
 * peer codes (other billing codes that map to the same service per `billing_code_identity`).
 * Letters render an alternative-code section using Q-S87-D2 Option 1 copy:
 *
 *   "Note: similar charges have been successfully resolved when re-coded as
 *    [alternative_code]. Please verify whether this code more accurately reflects
 *    the service provided."
 *
 * v1 guardrails (Subplan §5 mitigations + Q-S87 locks):
 *   - Peer codes surface ONLY from `billing_code_identity` rows where
 *     `promotion_state IN ('corroborated', 'admin_verified')` — protects against
 *     gaming via 1-user-discovers-a-pattern.
 *   - Letter section requires ≥2 distinct corroborated peer codes for the slug
 *     (avoids trivial "this code is the only peer" recommendation that's just
 *     re-coding to itself).
 *   - The denied line's own (code, slug) row is excluded from peer set.
 *   - No user-count or admin-attestation count surfaced in letter copy (Q-S87-D2).
 *
 * Pattern 1 #14 inheritance: queries `billing_code_identity` only (canonical-side
 * aggregated table); no user-row reads. Pattern 1 #15 inheritance: votes that
 * landed the slug at corroborated were all phone+email verified contributors.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface PeerCode {
  code: string;
  codeType: string;
  /** Identity row's confidence at time of query (read-time snapshot). */
  confidence: number;
  /** 'corroborated' or 'admin_verified'. */
  promotionState: "corroborated" | "admin_verified";
}

export interface PeerCodeQueryInput {
  /** The slug to find peer codes for. */
  serviceSlug: string;
  /** The contested line's billing code — EXCLUDED from results (don't suggest re-coding to itself). */
  excludeCode: string | null;
  /** The contested line's billing code type — paired with excludeCode for exact identity exclusion. */
  excludeCodeType: string | null;
}

export interface PeerCodeQueryResult {
  /** Sorted by confidence desc, then code asc for determinism. */
  peers: PeerCode[];
  /**
   * True when peers.length >= 2 — gate condition for letter rendering per Q-S87-C7 lock.
   * False suppresses the alternative-code section entirely (no recommendation
   * surfaced rather than a single-peer suggestion that may be the contested code's
   * synonym).
   */
  letterEligible: boolean;
}

const LETTER_PEER_FLOOR = 2;

export async function findPeerCodesForSlug(
  supabase: SupabaseClient,
  input: PeerCodeQueryInput,
): Promise<PeerCodeQueryResult> {
  if (!input.serviceSlug) {
    return { peers: [], letterEligible: false };
  }

  const { data, error } = await supabase
    .from("billing_code_identity")
    .select("billing_code, billing_code_type, confidence, promotion_state")
    .eq("service_slug", input.serviceSlug)
    .in("promotion_state", ["corroborated", "admin_verified"]);

  if (error) {
    console.warn("[peer-code-engine] lookup failed", error);
    return { peers: [], letterEligible: false };
  }

  const peers: PeerCode[] = (data ?? [])
    .map((r) => ({
      code: (r.billing_code as string | null) ?? "",
      codeType: (r.billing_code_type as string | null) ?? "",
      confidence: Number(r.confidence ?? 0.5),
      promotionState: (r.promotion_state as PeerCode["promotionState"]),
    }))
    .filter((p) => Boolean(p.code) && Boolean(p.codeType))
    .filter(
      (p) =>
        !(
          input.excludeCode &&
          input.excludeCodeType &&
          p.code === input.excludeCode &&
          p.codeType === input.excludeCodeType
        ),
    );

  peers.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.code.localeCompare(b.code);
  });

  return {
    peers,
    letterEligible: peers.length >= LETTER_PEER_FLOOR,
  };
}

/**
 * Renderer for the alternative-code section in dispute letters. Caller checks
 * letterEligible before calling; this helper emits nothing when peers is empty.
 *
 * Copy is Q-S87-D2 Option 1 lock — informational framing; user verifies. Avoids
 * surfacing distinct_user_count or admin attestation count per the lock.
 */
export function renderAlternativeCodeSection(
  contestedCode: string | null,
  peers: PeerCode[],
): string {
  if (peers.length < LETTER_PEER_FLOOR) return "";
  // Top-1 by confidence (already sorted). v1 surfaces a single alternative; if
  // telemetry shows users prefer multiple, Phase 2 can expand to a list.
  const top = peers[0];
  const codeContext = contestedCode ? `code ${contestedCode}` : "this charge";
  return `\nNote: similar charges have been successfully resolved when re-coded as ${top.code}. Please verify whether ${top.code} more accurately reflects the service provided for ${codeContext}, and reprocess accordingly if applicable.\n`;
}

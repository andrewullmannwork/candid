// Ing-G.2/3 — ingest-time orchestrator for the adversarial-PDF assessment.
//
// Called at the start of BOTH PDF parse entry points (process-chunk INIT +
// the legacy /api/documents/process route). Self-contained: reads its own flag,
// doc metadata, and writes the result — the caller passes only (supabase,
// documentId, bytes). IDEMPOTENT (skips if already assessed → retry/reprocess
// safe) and NON-FATAL (never throws → never blocks a parse; matches the OCR
// layer's "never crash the upload flow" discipline + Cost-F/Ing-K telemetry).
//
// Flag semantics (mig 153): enabled=false → never runs (byte-identical).
// enabled=true → config.mode shadow (telemetry only) | enforce (admin work-list).
// Never auto-rejects — admin review only at MVP.

import type { SupabaseClient } from "@supabase/supabase-js";
import { extractAdversarialPdfFeatures } from "./adversarial-pdf-features";
import {
  scoreAdversarialPdf,
  resolveAdversarialConfig,
  DEFAULT_ADVERSARIAL_CONFIG,
  type AdversarialPdfConfig,
} from "./adversarial-pdf";

const FLAG_KEY = "adversarial_pdf_detection";
/** Bump when the scorer logic/feature set changes, so G7 telemetry can group
 *  scores by the code that produced them (config tuning is tracked separately
 *  via the stored mode/threshold). */
export const ADVERSARIAL_RULESET_VERSION = "g23-v1";

/** Read the master gate + tunable config from the single flag row (mirrors
 *  loadCF40V4Config). Fails closed: any error → disabled. */
async function loadAdversarialPdfFlag(
  supabase: SupabaseClient,
): Promise<{ enabled: boolean; config: AdversarialPdfConfig }> {
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("enabled, config")
      .eq("flag_key", FLAG_KEY)
      .maybeSingle();
    return {
      enabled: data?.enabled === true,
      config: resolveAdversarialConfig((data?.config as Partial<AdversarialPdfConfig>) ?? null),
    };
  } catch {
    return { enabled: false, config: DEFAULT_ADVERSARIAL_CONFIG };
  }
}

export interface AssessAdversarialResult {
  ran: boolean;
  reason?: "disabled" | "already_assessed" | "error";
  flagged?: boolean;
  assessable?: boolean;
  score?: number;
}

/**
 * Assess a PDF at ingest. Writes `documents.metadata.adversarial_pdf_assessment`
 * when the flag is enabled. Returns a small status object; callers ignore it
 * (fire-and-forget) — this never blocks the parse.
 */
export async function assessAdversarialPdf(
  supabase: SupabaseClient,
  documentId: string,
  bytes: Uint8Array,
): Promise<AssessAdversarialResult> {
  try {
    const { enabled, config } = await loadAdversarialPdfFlag(supabase);
    if (!enabled) return { ran: false, reason: "disabled" };

    const { data: doc } = await supabase
      .from("documents")
      .select("classified_type, metadata")
      .eq("id", documentId)
      .maybeSingle();

    const existing = (doc?.metadata as Record<string, unknown> | null) ?? {};
    if (existing.adversarial_pdf_assessment) {
      return { ran: false, reason: "already_assessed" }; // idempotent (retry/reprocess)
    }

    const features = await extractAdversarialPdfFeatures(bytes);
    const result = scoreAdversarialPdf(
      features,
      (doc?.classified_type as string | null) ?? null,
      config,
    );

    const assessment = {
      score: result.score,
      flagged: result.flagged,
      assessable: result.assessable,
      reasons: result.reasons,
      features, // full vector → G7 shadow-scoring reconciliation vs the corpus
      mode: config.mode, // shadow vs enforce — the admin work-list surfaces enforce only
      threshold: config.threshold, // operating point that produced `flagged`
      ruleset_version: ADVERSARIAL_RULESET_VERSION,
      review_state: "unreviewed" as const,
      scored_at: new Date().toISOString(),
    };

    await supabase
      .from("documents")
      .update({ metadata: { ...existing, adversarial_pdf_assessment: assessment } })
      .eq("id", documentId);

    return { ran: true, flagged: result.flagged, assessable: result.assessable, score: result.score };
  } catch (err) {
    // Non-fatal: an adversarial-scoring failure must never block a parse.
    console.warn(`[adversarial-pdf] assess failed for ${documentId}: ${(err as Error).message}`);
    return { ran: false, reason: "error" };
  }
}

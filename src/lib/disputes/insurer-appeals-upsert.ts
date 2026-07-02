/**
 * insurer-appeals-upsert — Phase 6.1
 *
 * Called from the SBC / plan-doc extraction pipeline when Haiku returns an
 * `appeals_contact` block. Implements Pattern 1 component 2 from
 * Candid_Data_Patterns.md:
 *
 *   - Case A (no existing): insert, source = 'doc_extraction', bump
 *     verification_count = 1, write confirmation log.
 *   - Case B (matches existing): increment verification_count + bump
 *     last_confirmed_at. Write confirmation log as 'doc_corroboration'.
 *     DO NOT overwrite any fields.
 *   - Case C (conflicts with existing): write to insurer_appeals_proposed_changes
 *     for admin review. NEVER overwrite admin_verified data silently.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyInsurerAppealsProposal } from "./insurer-appeals-notify";

export interface ExtractedAppealsBlock {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  sourceExcerpt?: string | null;
  sourcePage?: number | null;
  confidence?: number | null;
}

export interface UpsertParams {
  insurerId: string;
  extracted: ExtractedAppealsBlock;
  userId: string | null;
  documentId: string | null;
}

export async function upsertAppealsFromDoc(
  supabase: SupabaseClient,
  params: UpsertParams,
): Promise<{ action: "inserted" | "corroborated" | "proposed" | "skipped" }> {
  const { insurerId, extracted, userId, documentId } = params;

  // Need an address to be useful. Phone-only is logged but not stored as
  // canonical.
  if (!extracted.addressLine1) return { action: "skipped" };

  const { data: current } = await supabase
    .from("insurer_catalog")
    .select("name, appeals_address_line_1, appeals_address_line_2, appeals_city, appeals_state, appeals_postal_code, appeals_phone, appeals_source, appeals_verification_count")
    .eq("id", insurerId)
    .maybeSingle();

  if (!current) return { action: "skipped" };

  const hasExisting = !!current.appeals_address_line_1;

  // Case A — no existing data. Insert + mark doc_extraction.
  if (!hasExisting) {
    await supabase
      .from("insurer_catalog")
      .update({
        appeals_address_line_1: extracted.addressLine1,
        appeals_address_line_2: extracted.addressLine2 ?? null,
        appeals_city: extracted.city ?? null,
        appeals_state: extracted.state ?? null,
        appeals_postal_code: extracted.postalCode ?? null,
        appeals_phone: extracted.phone ?? null,
        appeals_source: "doc_extraction",
        appeals_confidence: extracted.confidence ?? null,
        appeals_verification_count: 1,
        appeals_last_confirmed_at: new Date().toISOString(),
        appeals_updated_at: new Date().toISOString(),
      })
      .eq("id", insurerId);

    await logConfirmation(supabase, {
      insurerId,
      userId,
      action: "doc_corroboration",
      metadata: {
        document_id: documentId,
        source_excerpt: extracted.sourceExcerpt ?? null,
        source_page: extracted.sourcePage ?? null,
        case: "insert",
      },
    });
    return { action: "inserted" };
  }

  // Case B — matches existing. Increment verification_count, bump timestamp.
  if (matchesExisting(current, extracted)) {
    await supabase
      .from("insurer_catalog")
      .update({
        appeals_verification_count: (current.appeals_verification_count ?? 0) + 1,
        appeals_last_confirmed_at: new Date().toISOString(),
      })
      .eq("id", insurerId);

    await logConfirmation(supabase, {
      insurerId,
      userId,
      action: "doc_corroboration",
      metadata: {
        document_id: documentId,
        source_excerpt: extracted.sourceExcerpt ?? null,
        source_page: extracted.sourcePage ?? null,
        case: "corroborate",
      },
    });
    return { action: "corroborated" };
  }

  // Case C — conflict. Never auto-overwrite; log to proposed_changes.
  await supabase.from("insurer_appeals_proposed_changes").insert({
    insurer_id: insurerId,
    proposed_by: "doc_extraction",
    proposed_by_user_id: userId,
    source_document_id: documentId,
    source_excerpt: extracted.sourceExcerpt ?? null,
    current_values: {
      address_line_1: current.appeals_address_line_1,
      address_line_2: current.appeals_address_line_2,
      city: current.appeals_city,
      state: current.appeals_state,
      postal_code: current.appeals_postal_code,
      phone: current.appeals_phone,
      source: current.appeals_source,
    },
    proposed_values: {
      address_line_1: extracted.addressLine1,
      address_line_2: extracted.addressLine2 ?? null,
      city: extracted.city ?? null,
      state: extracted.state ?? null,
      postal_code: extracted.postalCode ?? null,
      phone: extracted.phone ?? null,
    },
    confidence: extracted.confidence ?? null,
    status: "pending",
  });

  // Real-time admin nudge (fail-soft) so the doc-extraction conflict gets reviewed
  // instead of sitting unseen in the queue.
  await notifyInsurerAppealsProposal({
    insurerName: current.name ?? "Unknown insurer",
    source: "doc_extraction",
    current: current.appeals_address_line_1
      ? {
          addressLine1: current.appeals_address_line_1,
          addressLine2: current.appeals_address_line_2,
          city: current.appeals_city,
          state: current.appeals_state,
          postalCode: current.appeals_postal_code,
          phone: current.appeals_phone,
        }
      : null,
    proposed: {
      addressLine1: extracted.addressLine1,
      addressLine2: extracted.addressLine2 ?? null,
      city: extracted.city ?? null,
      state: extracted.state ?? null,
      postalCode: extracted.postalCode ?? null,
      phone: extracted.phone ?? null,
    },
  });

  await logConfirmation(supabase, {
    insurerId,
    userId,
    action: "doc_corroboration",
    metadata: {
      document_id: documentId,
      case: "conflict",
      source_excerpt: extracted.sourceExcerpt ?? null,
      source_page: extracted.sourcePage ?? null,
    },
  });
  return { action: "proposed" };
}

function matchesExisting(
  current: {
    appeals_address_line_1: string | null;
    appeals_address_line_2: string | null;
    appeals_city: string | null;
    appeals_state: string | null;
    appeals_postal_code: string | null;
  },
  extracted: ExtractedAppealsBlock,
): boolean {
  const normalize = (s?: string | null) =>
    (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return (
    normalize(current.appeals_address_line_1) === normalize(extracted.addressLine1) &&
    normalize(current.appeals_city) === normalize(extracted.city) &&
    normalize(current.appeals_state) === normalize(extracted.state) &&
    normalize(current.appeals_postal_code) === normalize(extracted.postalCode)
  );
}

async function logConfirmation(
  supabase: SupabaseClient,
  params: {
    insurerId: string;
    userId: string | null;
    action: "confirmed" | "proposed_correction" | "doc_corroboration";
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await supabase.from("insurer_appeals_confirmations").insert({
    insurer_id: params.insurerId,
    user_id: params.userId,
    action: params.action,
    metadata: params.metadata,
  });
}

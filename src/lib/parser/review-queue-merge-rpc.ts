/**
 * Ing-I (S133) — Thin RPC wrapper for atomic MERGE flow.
 *
 * Calls Postgres function `merge_proposed_slug_into_canonical` (defined in
 * mig 127). The function handles advisory locking + transactional INSERT/UPDATE;
 * this wrapper just shapes the typed response.
 *
 * Why a separate file: keeps the resolver helper (heavy Haiku integration) +
 * the merge action (DB-only) decoupled. Different failure surfaces; different
 * test seams.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type MergeResult =
  | {
      ok: true;
      alias_slug: string;
      canonical_slug: string;
      concept_id: string | null;
    }
  | {
      ok: false;
      error:
        | "queue_row_not_found"
        | "queue_row_not_pending"
        | "canonical_not_found"
        | "proposed_slug_collides"
        | "merge_exception"
        | "rpc_call_failed";
      detail?: Record<string, unknown>;
    };

export async function mergeProposedSlugIntoCanonical(
  supabase: SupabaseClient,
  args: {
    queueId: string;
    canonicalSlug: string;
    adminUserId: string;
  },
): Promise<MergeResult> {
  const { data, error } = await supabase.rpc(
    "merge_proposed_slug_into_canonical",
    {
      p_queue_id: args.queueId,
      p_canonical_slug: args.canonicalSlug,
      p_admin_user_id: args.adminUserId,
    },
  );

  if (error) {
    return {
      ok: false,
      error: "rpc_call_failed",
      detail: { message: error.message, code: error.code ?? null },
    };
  }

  const raw = data as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      error: "rpc_call_failed",
      detail: { reason: "RPC returned non-object payload", payload: data as unknown },
    };
  }

  if (raw.ok === true) {
    return {
      ok: true,
      alias_slug: String(raw.alias_slug ?? ""),
      canonical_slug: String(raw.canonical_slug ?? ""),
      concept_id: (raw.concept_id as string | null) ?? null,
    };
  }

  const errKey = String(raw.error ?? "merge_exception") as Exclude<
    MergeResult,
    { ok: true }
  >["error"];
  return {
    ok: false,
    error: errKey,
    detail: raw,
  };
}

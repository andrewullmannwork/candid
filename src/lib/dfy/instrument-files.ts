/**
 * instrument-files — the ONE resolver from a signed instrument to its file
 * (S331).
 *
 * The member's engagement page and the operator's matter view both need the
 * same thing: the signed PDF behind an instrument, as a short-lived URL. The
 * member's route grew that inline (`documents.storage_path` → `createSignedUrl`)
 * and the operator's send kit was about to grow a second copy of it — two
 * resolvers for one artifact, free to drift on TTL, bucket or failure posture.
 *
 * One home. Both callers read it, so the operator downloads the byte-identical
 * file the member sees, from the same bucket, with the same lifetime.
 *
 * Scoped to the MEMBER who owns the document — an operator's authority to be
 * here is established upstream by `operatorScoped`; this never widens it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScoped } from "@/lib/security/user-scoped";

/** How long a signed instrument URL lives. One value, both surfaces. */
export const INSTRUMENT_URL_TTL_SECONDS = 600;

export interface InstrumentFile {
  fileName: string | null;
  /** The storage object, for server-side reads (the packet merge). */
  storagePath: string | null;
  /** Null when the document row or the object is gone — never a broken link. */
  pdfUrl: string | null;
}

const NONE: InstrumentFile = { fileName: null, storagePath: null, pdfUrl: null };

/**
 * Resolve one signed instrument's file. Fail-soft: a missing row, a missing
 * object or a storage hiccup yields nulls, never a throw — an unavailable PDF
 * must not take down the page that lists it.
 */
export async function signedInstrumentFile(
  supabase: SupabaseClient,
  memberUserId: string,
  documentId: string | null | undefined,
): Promise<InstrumentFile> {
  if (!documentId) return NONE;
  try {
    const { data } = await userScoped(supabase, memberUserId)
      .table("documents")
      .select("file_name, storage_path")
      .eq("id", documentId)
      .maybeSingle();
    const doc = data as { file_name?: string | null; storage_path?: string | null } | null;
    if (!doc?.storage_path) return { fileName: doc?.file_name ?? null, storagePath: null, pdfUrl: null };
    const { data: url } = await supabase.storage
      .from("documents")
      .createSignedUrl(doc.storage_path, INSTRUMENT_URL_TTL_SECONDS);
    return { fileName: doc.file_name ?? null, storagePath: doc.storage_path, pdfUrl: url?.signedUrl ?? null };
  } catch (err) {
    console.error("[instrument-files] resolve failed (non-fatal):", err);
    return NONE;
  }
}

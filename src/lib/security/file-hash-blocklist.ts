import type { SupabaseClient } from "@supabase/supabase-js";
import { isFeatureEnabled } from "@/lib/config/product-flags";

/**
 * Ing-G.4 — file_hash_blocklist (mig 119) lookup helper.
 *
 * Returns true if the upload should be rejected. Two short-circuit conditions:
 *   1. `file_hash_blocklist_enabled` flag is OFF → return false (gate disabled).
 *   2. No row matches in `file_hash_blocklist` for the given hash → return false.
 *
 * The flag is read every call (no in-memory cache). Flag table reads are
 * already common in the upload path (turnstile, async_ingestion_ux, etc.) so
 * one more query is not a meaningful budget hit. Caching would surface
 * staleness if an operator flips the flag OFF mid-incident.
 */
export async function isHashBlocked(
  supabase: SupabaseClient,
  fileHash: string,
): Promise<boolean> {
  const gateEnabled = await isFeatureEnabled("file_hash_blocklist_enabled");
  if (!gateEnabled) return false;

  const { data, error } = await supabase
    .from("file_hash_blocklist")
    .select("file_hash")
    .eq("file_hash", fileHash)
    .maybeSingle();

  if (error) {
    console.warn(
      `[file-hash-blocklist] lookup failed for hash=${fileHash.slice(0, 8)}…: ${error.message}`,
    );
    return false;
  }

  return data != null;
}

/**
 * Prompt loader for Pattern P-Q admin tuning UI (S93 Stage 5a).
 *
 * Reads the active row from `parser_prompt_versions` (mig 102) at parse time
 * with a 5-min in-process cache. Falls back to the compile-time const passed
 * as `fallbackText` when:
 *   - No active DB row exists for the (file_path, supplement_key) — initial
 *     state pre-tuning, or after revert that hasn't propagated yet.
 *   - DB fetch fails (connection error, RLS block, etc) — degrade gracefully
 *     rather than throw at parse time.
 *
 * Cache invalidation: `bustPromptCache()` is called by the save / revert
 * endpoints in Stage 5c. The 5-min TTL bounds staleness if a remote process
 * misses the bust signal (e.g., serverless cold start with stale cache from
 * prior warm pool).
 */

import { createServerClient } from "@/lib/supabase/server";

interface CacheEntry {
  text: string;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function cacheKey(filePath: string, supplementKey: string): string {
  return `${filePath}::${supplementKey}`;
}

/**
 * Load the active version of a prompt supplement.
 *
 * @param promptFilePath  e.g., 'src/lib/plan_doc/haiku-prompts/services-cost-sharing.ts'
 * @param supplementKey   e.g., 'FEDERAL_SBC_TABULAR_SUPPLEMENT'
 * @param fallbackText    Compile-time const text used when no active DB row exists or DB fetch fails.
 */
export async function loadActiveSupplement(
  promptFilePath: string,
  supplementKey: string,
  fallbackText: string,
): Promise<string> {
  const key = cacheKey(promptFilePath, supplementKey);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.text;
  }

  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("parser_prompt_versions")
      .select("full_prompt_text")
      .eq("prompt_file_path", promptFilePath)
      .eq("supplement_key", supplementKey)
      .eq("is_active", true)
      .maybeSingle();

    if (error) {
      // Row-level error (not "no row found" — that's null data with no error)
      console.warn(
        `[prompt-loader] DB error for ${key}; using fallback. Error: ${error.message}`,
      );
      // Don't cache the fallback on DB error — retry on next call after TTL would have been wrong
      return fallbackText;
    }

    const text = data?.full_prompt_text ?? fallbackText;
    cache.set(key, { text, fetchedAt: Date.now() });
    return text;
  } catch (err) {
    // Connection-level failure (createServerClient threw, network blip, etc).
    // Use fallback; do NOT cache so next call will retry.
    console.warn(
      `[prompt-loader] DB fetch failed for ${key}; using fallback. Error:`,
      err,
    );
    return fallbackText;
  }
}

/**
 * Invalidate cached prompt(s). Called after admin save / revert endpoints
 * commit a new active version.
 *
 * @param promptFilePath  Optional. If omitted, clear entire cache.
 * @param supplementKey   Optional. If omitted with filePath, clear all keys
 *                        for that file. If both omitted, clear entire cache.
 */
export function bustPromptCache(promptFilePath?: string, supplementKey?: string): void {
  if (!promptFilePath) {
    cache.clear();
    return;
  }
  if (!supplementKey) {
    // Clear all keys for this file
    for (const key of cache.keys()) {
      if (key.startsWith(`${promptFilePath}::`)) {
        cache.delete(key);
      }
    }
    return;
  }
  cache.delete(cacheKey(promptFilePath, supplementKey));
}

/**
 * Test-only: clear the entire cache. Used by unit tests to ensure each test
 * starts with a clean cache state. NOT exported via the public API surface;
 * import directly from the file in tests.
 */
export function __resetCacheForTests(): void {
  cache.clear();
}

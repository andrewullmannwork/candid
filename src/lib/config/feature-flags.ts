/**
 * Feature flags and cost protection configuration.
 *
 * Priority: Database (admin-toggleable) → Environment variable → Default value
 *
 * To change flags:
 * - Admin UI: /admin/settings (instant, no deploy)
 * - Env var: .env.local or Vercel env vars (requires restart/deploy)
 *
 * Cost protection strategy:
 * - Store uploaded documents immediately (cheap storage)
 * - Gate expensive OCR processing behind daily/monthly caps
 * - Admin can always override caps manually
 * - Feature flags control which expensive features are active
 */

import { createServerClient } from "@/lib/supabase/server";

// In-memory cache (refreshed every 60 seconds)
let _cache: Record<string, string> | null = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

/** Load flags from database with caching */
async function loadDbFlags(): Promise<Record<string, string>> {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) return _cache;

  try {
    const supabase = createServerClient();
    const { data } = await supabase.from("feature_flags").select("key, value");
    _cache = {};
    for (const row of data || []) {
      _cache[row.key] = row.value;
    }
    _cacheTime = now;
  } catch {
    _cache = _cache || {};
  }
  return _cache;
}

/** Clear cache (call after admin updates a flag) */
export function clearFlagCache() {
  _cache = null;
  _cacheTime = 0;
}

/** Get a flag value: DB → env → default */
async function getFlag(key: string, defaultValue: string): Promise<string> {
  // Check env var first (allows override without DB)
  const envVal = process.env[key];
  if (envVal !== undefined) return envVal;

  // Check database
  const dbFlags = await loadDbFlags();
  if (key in dbFlags) return dbFlags[key];

  return defaultValue;
}

async function getFlagBool(key: string, defaultValue: boolean): Promise<boolean> {
  const val = await getFlag(key, String(defaultValue));
  return val === "true" || val === "1";
}

async function getFlagInt(key: string, defaultValue: number): Promise<number> {
  const val = await getFlag(key, String(defaultValue));
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/** All feature flags — async because it checks the database */
export async function getFlags() {
  return {
    OCR_ENABLED: await getFlagBool("OCR_ENABLED", true),
    AUTO_PROCESS_ON_UPLOAD: await getFlagBool("AUTO_PROCESS_ON_UPLOAD", false),
    OCR_MONTHLY_PAGE_LIMIT: await getFlagInt("OCR_MONTHLY_PAGE_LIMIT", 900),
    OCR_DAILY_PAGE_LIMIT: await getFlagInt("OCR_DAILY_PAGE_LIMIT", 200),
    CLAUDE_EXTRACTION_ENABLED: await getFlagBool("CLAUDE_EXTRACTION_ENABLED", false),
    UPLOAD_MAX_FILE_SIZE: await getFlagInt("UPLOAD_MAX_FILE_SIZE", 20 * 1024 * 1024),
    UPLOAD_MAX_PAGES: await getFlagInt("UPLOAD_MAX_PAGES", 90),
    UPLOAD_MAX_PER_USER: await getFlagInt("UPLOAD_MAX_PER_USER", 10),
    ON_DEMAND_EXTRACTION_ENABLED: await getFlagBool("ON_DEMAND_EXTRACTION_ENABLED", true),
  };
}

/**
 * Synchronous fallback for non-async contexts (env-var only, no DB check).
 * Use getFlags() whenever possible.
 */
export const FLAGS = {
  OCR_ENABLED: envBool("OCR_ENABLED", true),
  AUTO_PROCESS_ON_UPLOAD: envBool("AUTO_PROCESS_ON_UPLOAD", false),
  OCR_MONTHLY_PAGE_LIMIT: envInt("OCR_MONTHLY_PAGE_LIMIT", 900),
  OCR_DAILY_PAGE_LIMIT: envInt("OCR_DAILY_PAGE_LIMIT", 200),
  CLAUDE_EXTRACTION_ENABLED: envBool("CLAUDE_EXTRACTION_ENABLED", false),
  UPLOAD_MAX_FILE_SIZE: envInt("UPLOAD_MAX_FILE_SIZE", 20 * 1024 * 1024),
  UPLOAD_MAX_PAGES: envInt("UPLOAD_MAX_PAGES", 90),
  UPLOAD_MAX_PER_USER: envInt("UPLOAD_MAX_PER_USER", 10),
  ON_DEMAND_EXTRACTION_ENABLED: envBool("ON_DEMAND_EXTRACTION_ENABLED", true),
} as const;

function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  return val === "true" || val === "1";
}

function envInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

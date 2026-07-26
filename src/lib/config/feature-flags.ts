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
    UPLOAD_MAX_PAGES: await getFlagInt("UPLOAD_MAX_PAGES", 100),
    UPLOAD_MAX_PER_USER: await getFlagInt("UPLOAD_MAX_PER_USER", 10),
    // Cost-H.2 (S198) — async-ingestion UX two-tier page gates, decoupled per
    // Andrew: pageCount > REDIRECT → async "go explore" splash (isLargeDoc);
    // pageCount > EMAIL → ALSO send the parse-complete email. Both default 30
    // (= the prior single hardcoded LARGE_DOC_PAGE_THRESHOLD) so behavior is
    // unchanged until REDIRECT is lowered (to 15) in lockstep with the frontend
    // tier-aware splash copy (§R.2). Tunable in /admin/settings — no deploy.
    ASYNC_REDIRECT_MAX_PAGES: await getFlagInt("ASYNC_REDIRECT_MAX_PAGES", 30),
    ASYNC_EMAIL_MAX_PAGES: await getFlagInt("ASYNC_EMAIL_MAX_PAGES", 30),
    ON_DEMAND_EXTRACTION_ENABLED: await getFlagBool("ON_DEMAND_EXTRACTION_ENABLED", true),
    MAX_EXTRACTED_SERVICES: await getFlagInt("MAX_EXTRACTED_SERVICES", 125),
    // Compare premium flywheel: min distinct member observations on a plan before
    // a community average premium is shown (k-anon floor, Rule #5). Adjustable in
    // /admin/settings. Consumed by the flywheel aggregation read-back (follow-up).
    COMPARE_FLYWHEEL_MIN_MEMBERS: await getFlagInt("COMPARE_FLYWHEEL_MIN_MEMBERS", 5),
    // Test-phone exemption kill switch (S288, mig 209) — allows the ONE
    // hardcoded test number (src/lib/auth/test-phone-exempt.ts) on multiple
    // accounts. Default false: no DB row → strict phone behavior.
    TEST_PHONE_EXEMPTION_ENABLED: await getFlagBool("TEST_PHONE_EXEMPTION_ENABLED", false),
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
  UPLOAD_MAX_PAGES: envInt("UPLOAD_MAX_PAGES", 100),
  UPLOAD_MAX_PER_USER: envInt("UPLOAD_MAX_PER_USER", 10),
  ASYNC_REDIRECT_MAX_PAGES: envInt("ASYNC_REDIRECT_MAX_PAGES", 30),
  ASYNC_EMAIL_MAX_PAGES: envInt("ASYNC_EMAIL_MAX_PAGES", 30),
  ON_DEMAND_EXTRACTION_ENABLED: envBool("ON_DEMAND_EXTRACTION_ENABLED", true),
  MAX_EXTRACTED_SERVICES: envInt("MAX_EXTRACTED_SERVICES", 125),
  COMPARE_FLYWHEEL_MIN_MEMBERS: envInt("COMPARE_FLYWHEEL_MIN_MEMBERS", 5),
  TEST_PHONE_EXEMPTION_ENABLED: envBool("TEST_PHONE_EXEMPTION_ENABLED", false),
} as const;

/**
 * Cost-H.2 (S198) — the async-ingestion UX tier for a PDF upload. Two DECOUPLED
 * page gates: REDIRECT (→ async "go explore" splash + completion banner) and
 * EMAIL (→ ALSO send the parse-complete email). When EMAIL >= REDIRECT the email
 * tier is a subset of the redirect tier, so the future 15-30 band (once
 * REDIRECT=15) gets the splash + banner but NO email. Pure + exported so the
 * upload route AND the fixture share ONE definition. `willEmail` mirrors the
 * onboarding-emails gate (pageCount > EMAIL) so the frontend can pick
 * email-promise vs in-app-banner copy without duplicating the threshold.
 */
export function classifyAsyncDocTier(args: {
  pageCount: number;
  isPdf: boolean;
  asyncEnabled: boolean;
  redirectMaxPages: number;
  emailMaxPages: number;
}): { isLargeDoc: boolean; willEmail: boolean } {
  return {
    isLargeDoc: args.asyncEnabled && args.isPdf && args.pageCount > args.redirectMaxPages,
    willEmail: args.pageCount > args.emailMaxPages,
  };
}

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

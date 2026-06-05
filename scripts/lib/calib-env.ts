/**
 * Canonical environment bootstrap for calibration / script entry points (S170).
 *
 * Replaces the ad-hoc `config({ path: resolve(process.cwd(), ".env.local") })` repeated across ~124
 * scripts. That pattern is (a) CWD-dependent, (b) uses dotenv's silent no-override — so a stale or
 * EMPTY shell var WINS (Claude Code's shell pre-sets ANTHROPIC_API_KEY=""), and (c) never validates
 * that required creds actually loaded. The combination silently degrades a run (e.g. a calibration
 * gate resolving every Haiku-tier line to null) with NO signal — a result that looks valid but isn't.
 *
 * loadCalibEnv():
 *   - finds .env.local by walking UP from cwd (tolerates running from a subdir; not "exactly cwd/")
 *   - config({ override: true }) so a stale/empty shell var cannot win over .env.local
 *   - asserts every required var is present AND non-empty, throwing a clear, actionable error otherwise
 *   - returns the validated values
 *
 * Every calibration entry point should call this at startup instead of dotenv directly.
 */
import { config } from "dotenv";
import { existsSync } from "fs";
import { dirname, resolve } from "path";

const DEFAULT_REQUIRED = ["ANTHROPIC_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

/** Walk up from cwd to find .env.local (CWD-tolerant; throws if not found inside the repo). */
function findEnvLocal(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const candidate = resolve(dir, ".env.local");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`calib-env: .env.local not found walking up from cwd (${process.cwd()}). Run from inside the repo.`);
}

/**
 * Load + validate the calibration environment. Pass extra required var names beyond the defaults.
 * Throws (loud, actionable) if any required var is missing or empty — never returns a degraded env.
 */
export function loadCalibEnv(extraRequired: readonly string[] = []): Record<string, string> {
  config({ path: findEnvLocal(), override: true });
  const required = [...DEFAULT_REQUIRED, ...extraRequired];
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim() === "");
  if (missing.length) {
    throw new Error(
      `calib-env: required env var(s) missing or empty: ${missing.join(", ")}.\n` +
        `  override:true should have injected these from .env.local — if they are still empty, they are ` +
        `absent from .env.local (or .env.local was not found). This guard exists because Claude Code's ` +
        `shell pre-sets ANTHROPIC_API_KEY="" and dotenv's default no-override would silently keep it empty, ` +
        `degrading the run to all-null Haiku resolutions.`,
    );
  }
  return Object.fromEntries(required.map((k) => [k, process.env[k] as string]));
}

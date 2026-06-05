/**
 * Ing-E Phase 2 — PII redaction flag gate.
 *
 * Reads the `pii_redaction_enabled` rule flag (feature_flag_rules) and applies the
 * redactor at canonical-write chokepoints. Default OFF: when the flag ROW IS ABSENT
 * (it isn't seeded until the post-adjudication flip) → returns false → redaction is
 * skipped → byte-identical PROD. No migration needed to land this code.
 *
 * Rollout model: redaction is a SAFETY feature (it only removes PII; over-redaction
 * is structurally prevented by the COVERAGE_GUARD + the precision gate), so the
 * model is OFF → global ON after adjudication validates precision — no %/admin ramp
 * needed. (If staged targeting is ever wanted, thread the uploader and reuse the
 * cf40_v4 evaluator.)
 *
 * Fail-open to byte-identical: any read error → false. Never block a canonical write
 * on a flag-read failure.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { redactText } from "./pii-redactor";

let cached: { value: boolean; at: number } | null = null;
const TTL_MS = 30_000;

export async function isPiiRedactionEnabled(supabase: SupabaseClient): Promise<boolean> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;
  let value = false;
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("enabled")
      .eq("flag_key", "pii_redaction_enabled")
      .maybeSingle();
    value = (data as unknown as { enabled?: boolean } | null)?.enabled === true;
  } catch {
    value = false; // fail-open to byte-identical
  }
  cached = { value, at: now };
  return value;
}

/**
 * Redact a single excerpt for a canonical/cross-user write when `enabled`. Returns
 * the input UNCHANGED (same type, same value) when disabled or empty → byte-identical.
 * Emits a structured warn on a real redaction (the minimal G7 fire-telemetry hook;
 * a proper redaction_events table is the flip-time follow-on).
 */
export function redactExcerpt<T extends string | null>(text: T, enabled: boolean, ctx: string): T {
  if (!enabled || !text) return text;
  try {
    const r = redactText(text);
    if (r.changed) {
      console.warn(
        `[pii-redactor] redacted ${r.redactions.length} span(s) @ ${ctx}: ${[...new Set(r.redactions.map((x) => x.patternName))].join(",")}`,
      );
    }
    return r.redacted as T;
  } catch (err) {
    // Fail-safe: a redactor bug must NEVER break a canonical write. Pass the
    // original text through (flip the flag OFF to stop redacting) + warn loudly.
    console.warn(`[pii-redactor] redactExcerpt threw @ ${ctx} — passing through unredacted`, err);
    return text;
  }
}

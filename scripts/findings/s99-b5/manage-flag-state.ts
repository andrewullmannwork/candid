/**
 * S99 B5 — manage the two feature flags needed to smoke-test the B5
 * doc-type confirmation modal. Saves baseline state to a JSON file so the
 * revert restores EXACTLY what was there before.
 *
 * Modes:
 *   --apply   Read current state of doc_type_override_v1 +
 *             classifier_haiku_regex_fallback_v1; save baseline to
 *             flag-baseline.json; then apply test config (lower
 *             classifier_confidence_override to 0.95 + enable fallback flag).
 *
 *   --revert  Read flag-baseline.json; restore both flags to baseline state;
 *             delete the baseline file.
 *
 * Run: `npx tsx scripts/findings/s99-b5/manage-flag-state.ts --apply`
 *      `npx tsx scripts/findings/s99-b5/manage-flag-state.ts --revert`
 */
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

loadEnv({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const BASELINE_PATH = resolve(
  "scripts/findings/s99-b5/flag-baseline.json",
);

const FLAGS = [
  "doc_type_override_v1",
  "classifier_haiku_regex_fallback_v1",
] as const;

type FlagRow = {
  flag_key: string;
  enabled: boolean;
  target_type: string;
  config: Record<string, unknown> | null;
};

async function readFlag(flagKey: string): Promise<FlagRow> {
  const { data, error } = await supabase
    .from("feature_flag_rules")
    .select("flag_key, enabled, target_type, config")
    .eq("flag_key", flagKey)
    .single();
  if (error) throw new Error(`read ${flagKey}: ${error.message}`);
  return data as FlagRow;
}

async function writeFlag(
  flagKey: string,
  patch: { enabled?: boolean; target_type?: string; config?: Record<string, unknown> | null },
): Promise<void> {
  const { error } = await supabase
    .from("feature_flag_rules")
    .update(patch)
    .eq("flag_key", flagKey);
  if (error) throw new Error(`write ${flagKey}: ${error.message}`);
}

async function apply(): Promise<void> {
  console.log("Reading current flag state...");
  const baseline: Record<string, FlagRow> = {};
  for (const key of FLAGS) {
    const row = await readFlag(key);
    baseline[key] = row;
    console.log(`  ${key}: enabled=${row.enabled} target_type=${row.target_type} config=${JSON.stringify(row.config)}`);
  }

  if (existsSync(BASELINE_PATH)) {
    console.log(
      `\n⚠️  ${BASELINE_PATH} already exists. Previous test run may not have reverted. Refusing to overwrite — run --revert first if the existing baseline is current, or delete the file if it's stale.`,
    );
    process.exit(1);
  }

  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
  console.log(`\n✅ Baseline saved to ${BASELINE_PATH}`);

  console.log("\nApplying test config...");

  // 1. doc_type_override_v1 — widen medium band by raising
  //    classifier_confidence_override from 0.8 to 0.95
  const overrideBaseline = baseline.doc_type_override_v1;
  const newOverrideConfig = {
    ...(overrideBaseline.config ?? {}),
    classifier_confidence_override: 0.95,
  };
  await writeFlag("doc_type_override_v1", { config: newOverrideConfig });
  console.log(`  doc_type_override_v1.config.classifier_confidence_override → 0.95`);

  // 2. classifier_haiku_regex_fallback_v1 — enable globally for smoke
  await writeFlag("classifier_haiku_regex_fallback_v1", { enabled: true });
  console.log(`  classifier_haiku_regex_fallback_v1.enabled → true`);

  console.log("\n✅ Test config applied. Run smoke now.");
  console.log("\nWhen smoke is done, run:");
  console.log("  npx tsx scripts/findings/s99-b5/manage-flag-state.ts --revert");
}

async function revert(): Promise<void> {
  if (!existsSync(BASELINE_PATH)) {
    console.log(`❌ No baseline at ${BASELINE_PATH} — nothing to revert from.`);
    console.log("   Either --apply was never run, or revert already completed.");
    process.exit(1);
  }

  console.log(`Reading baseline from ${BASELINE_PATH}...`);
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as Record<string, FlagRow>;

  for (const key of FLAGS) {
    const b = baseline[key];
    if (!b) {
      console.log(`  ⚠️  baseline missing for ${key}; skipping`);
      continue;
    }
    await writeFlag(key, {
      enabled: b.enabled,
      target_type: b.target_type,
      config: b.config,
    });
    console.log(`  ${key}: restored enabled=${b.enabled} target_type=${b.target_type} config=${JSON.stringify(b.config)}`);
  }

  unlinkSync(BASELINE_PATH);
  console.log(`\n✅ Reverted. Baseline file deleted.`);

  // Verify by re-reading.
  console.log("\nVerifying restoration...");
  for (const key of FLAGS) {
    const row = await readFlag(key);
    console.log(`  ${key}: enabled=${row.enabled} target_type=${row.target_type} config=${JSON.stringify(row.config)}`);
  }
}

const mode = process.argv[2];
if (mode === "--apply") {
  apply().catch((err) => {
    console.error("apply failed:", err);
    process.exit(1);
  });
} else if (mode === "--revert") {
  revert().catch((err) => {
    console.error("revert failed:", err);
    process.exit(1);
  });
} else {
  console.error("Usage: manage-flag-state.ts --apply | --revert");
  process.exit(1);
}

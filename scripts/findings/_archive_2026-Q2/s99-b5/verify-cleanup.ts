/**
 * Post-fixture cleanup verifier. Runs after test-pattern1-concept-grouped.ts
 * to confirm zero `s99b5-test-*` rows remain in any of the touched tables.
 */
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const TEST_PREFIX = "s99b5-test-";

async function main() {
  let totalLeftover = 0;

  const { data: scRows } = await supabase
    .from("service_catalog")
    .select("slug")
    .like("slug", `${TEST_PREFIX}%`);
  console.log(`service_catalog rows matching prefix: ${scRows?.length ?? 0}`);
  totalLeftover += scRows?.length ?? 0;

  const { data: conceptRows } = await supabase
    .from("concepts")
    .select("concept_code")
    .eq("vocabulary_id", "CANDID")
    .like("concept_code", `${TEST_PREFIX}%`);
  console.log(`concepts rows matching prefix: ${conceptRows?.length ?? 0}`);
  totalLeftover += conceptRows?.length ?? 0;

  const { data: cpRows } = await supabase
    .from("canonical_plans")
    .select("id")
    .like("plan_name", `${TEST_PREFIX}%`);
  console.log(`canonical_plans rows matching prefix: ${cpRows?.length ?? 0}`);
  totalLeftover += cpRows?.length ?? 0;

  const { data: userRows } = await supabase
    .from("users")
    .select("id")
    .like("email", `${TEST_PREFIX}%`);
  console.log(`users rows matching prefix: ${userRows?.length ?? 0}`);
  totalLeftover += userRows?.length ?? 0;

  if (totalLeftover === 0) {
    console.log("\n✅ All test fixture rows cleaned up; PROD pristine.");
    process.exit(0);
  } else {
    console.log(`\n❌ ${totalLeftover} leftover rows detected. Manual cleanup needed.`);
    process.exit(1);
  }
}

main();

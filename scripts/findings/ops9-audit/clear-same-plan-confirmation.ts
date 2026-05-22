/**
 * S109 PR #2 (Chunk B) + S110 Chunk D testing helper — clear dispute-letter
 * banner + bind state on Andrew's disputes so the SamePlanConfirmBanner +
 * Find-in-library CTA re-appear for re-testing.
 *
 * Removes from each Andrew-owned dispute's metadata:
 *   - userConfirmedSamePlan + userConfirmedSamePlanAt (Chunk B banner answer)
 *   - canonicalPlanIdForBillYear + canonicalPlanBoundAt (Chunk D manual bind)
 *
 * Other metadata fields (claimLineItemIds, lastRedraftAt, redraftHistory,
 * planContextFingerprint, etc.) are preserved.
 *
 * Run: `npx tsx scripts/findings/ops9-audit/clear-same-plan-confirmation.ts`
 * Dry-run: `npx tsx scripts/findings/ops9-audit/clear-same-plan-confirmation.ts --dry-run`
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: "/Users/andrewullmann/Desktop/candid/.env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ADMIN_EMAIL = "andrew.david.ullmann@gmail.com";
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id, email")
    .eq("email", ADMIN_EMAIL)
    .single();
  if (userErr || !user) {
    console.error(`User ${ADMIN_EMAIL} not found:`, userErr);
    process.exit(1);
  }
  console.log(`User: ${user.email} (${user.id})`);

  const { data: disputes, error: fetchErr } = await supabase
    .from("dispute_outcomes")
    .select("id, claim_id, metadata, updated_at")
    .eq("user_id", user.id);
  if (fetchErr) {
    console.error("Failed to fetch disputes:", fetchErr);
    process.exit(1);
  }
  if (!disputes || disputes.length === 0) {
    console.log("No disputes found for this user.");
    return;
  }

  let touched = 0;
  for (const d of disputes) {
    const meta = (d.metadata as Record<string, unknown> | null) ?? {};
    const hasBannerState =
      meta.userConfirmedSamePlan != null || meta.userConfirmedSamePlanAt != null;
    const hasBindState =
      meta.canonicalPlanIdForBillYear != null || meta.canonicalPlanBoundAt != null;
    if (!hasBannerState && !hasBindState) {
      continue;
    }
    console.log(
      `  - dispute ${d.id.slice(0, 8)} (claim ${String(d.claim_id ?? "—").slice(0, 8)}): clearing userConfirmedSamePlan=${meta.userConfirmedSamePlan ?? "null"}, canonicalPlanIdForBillYear=${typeof meta.canonicalPlanIdForBillYear === "string" ? (meta.canonicalPlanIdForBillYear as string).slice(0, 8) : "null"}`,
    );
    if (DRY_RUN) {
      touched++;
      continue;
    }
    const next: Record<string, unknown> = { ...meta };
    delete next.userConfirmedSamePlan;
    delete next.userConfirmedSamePlanAt;
    delete next.canonicalPlanIdForBillYear;
    delete next.canonicalPlanBoundAt;
    const { error: updErr } = await supabase
      .from("dispute_outcomes")
      .update({ metadata: next, updated_at: new Date().toISOString() })
      .eq("id", d.id);
    if (updErr) {
      console.error(`    UPDATE failed for ${d.id}:`, updErr);
      continue;
    }
    touched++;
  }

  console.log(
    `\n${DRY_RUN ? "[dry-run] would clear" : "Cleared"} banner + bind state on ${touched} of ${disputes.length} dispute${disputes.length === 1 ? "" : "s"}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

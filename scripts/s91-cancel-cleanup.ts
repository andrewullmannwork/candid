/**
 * Find + clean up the canceled Cigna 2024 EOC upload(s) from the
 * "merge + ship" dry-run that surfaced the legacy-panel bug. Marks docs
 * status='error' (with reason note) and any insurance_plans rows
 * historical_only=true so they don't pollute future tests.
 *
 * Read-only by default; pass `--apply` to actually write.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  const userId = "2ce55772-bdf1-4edd-bd16-215aa239990e";
  console.log(`Cleanup mode: ${APPLY ? "APPLY ✍️" : "DRY-RUN 👀"}\n`);

  const { data: docs } = await sb
    .from("documents")
    .select("id,doc_type,status,processing_step,file_hash,file_name,created_at")
    .eq("user_id", userId)
    .like("file_hash", "c1c35da73771%")
    .order("created_at", { ascending: false });
  console.log(`Cigna Plan Benefits.pdf docs:\n${JSON.stringify(docs, null, 2)}`);

  if (!docs || docs.length === 0) return;

  const planQueries = await Promise.all(docs.map((d) => sb
    .from("insurance_plans")
    .select("id,insurer_name,plan_name,plan_year,is_active,historical_only")
    .eq("source_document_id", d.id)
  ));
  for (let i = 0; i < docs.length; i++) {
    console.log(`\nDoc ${docs[i].id.substring(0, 8)} linked plans:`, JSON.stringify(planQueries[i].data, null, 2));
  }

  if (APPLY) {
    for (const d of docs) {
      if (d.status !== "error") {
        const { error } = await sb
          .from("documents")
          .update({ status: "error", processing_step: "canceled_s91_dryrun", processing_error: "Canceled mid-S91 dry-run after legacy-panel bug surfaced; re-test post-fix." })
          .eq("id", d.id);
        console.log(`  marked doc ${d.id.substring(0, 8)} status=error: ${error ? error.message : "ok"}`);
      }
    }
    for (const q of planQueries) {
      if (!q.data) continue;
      for (const p of q.data) {
        if (!p.historical_only) {
          const { error } = await sb
            .from("insurance_plans")
            .update({ is_active: false, historical_only: true })
            .eq("id", p.id);
          console.log(`  marked plan ${p.id.substring(0, 8)} historical_only=true: ${error ? error.message : "ok"}`);
        }
      }
    }
  } else {
    console.log("\nDry-run only — re-run with --apply to write.");
  }
}
main().catch(console.error);

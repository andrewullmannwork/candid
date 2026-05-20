/**
 * OPS.9 Session 1 — cold-start + canonical detail probe.
 * Read-only.
 *
 * Usage: cd /Users/andrewullmann/Desktop/candid && npx tsx scripts/findings/ops9-audit/query-prod-coldstart-detail.ts
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  // total canonical_plans count
  const { count: cpTotal } = await supabase
    .from("canonical_plans")
    .select("*", { count: "exact", head: true });
  console.log(`canonical_plans total: ${cpTotal}`);

  // canonical_plans by state
  const { data: cpRows } = await supabase
    .from("canonical_plans")
    .select("state, plan_year")
    .order("created_at", { ascending: false })
    .limit(5000);
  const byState: Record<string, number> = {};
  const byYear: Record<string, number> = {};
  for (const r of cpRows ?? []) {
    const rr = r as { state: string | null; plan_year: number | null };
    byState[rr.state ?? "NULL"] = (byState[rr.state ?? "NULL"] ?? 0) + 1;
    byYear[String(rr.plan_year ?? "NULL")] = (byYear[String(rr.plan_year ?? "NULL")] ?? 0) + 1;
  }
  console.log(`canonical_plans by state: ${JSON.stringify(byState, null, 2)}`);
  console.log(`canonical_plans by plan_year: ${JSON.stringify(byYear, null, 2)}`);

  // recent cold-start documents — when was the most recent one created?
  const { data: recentDocs } = await supabase
    .from("documents")
    .select("id, created_at, metadata")
    .not("metadata", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);
  const coldStartDocs = (recentDocs ?? []).filter((d) => {
    const m = (d as { metadata: Record<string, unknown> | null }).metadata;
    return m && typeof m === "object" && "seeded_via" in m;
  });
  console.log(`Recent cold-start docs sample: ${coldStartDocs.length}`);
  if (coldStartDocs.length > 0) {
    const first = coldStartDocs[0] as { created_at: string };
    const last = coldStartDocs[coldStartDocs.length - 1] as { created_at: string };
    console.log(`Newest cold-start doc: ${first.created_at}`);
    console.log(`Oldest in sample: ${last.created_at}`);
  }

  // total documents count
  const { count: docTotal } = await supabase
    .from("documents")
    .select("*", { count: "exact", head: true });
  console.log(`documents total: ${docTotal}`);

  // users count + email_verified + phone_verified
  const { count: usersTotal } = await supabase
    .from("users")
    .select("*", { count: "exact", head: true });
  console.log(`users total: ${usersTotal}`);

  const { count: emailVerified } = await supabase
    .from("users")
    .select("*", { count: "exact", head: true })
    .eq("email_verified", true);
  const { count: phoneVerified } = await supabase
    .from("users")
    .select("*", { count: "exact", head: true })
    .eq("phone_verified", true);
  const { count: bothVerified } = await supabase
    .from("users")
    .select("*", { count: "exact", head: true })
    .eq("email_verified", true)
    .eq("phone_verified", true);
  console.log(`users email_verified=true: ${emailVerified}`);
  console.log(`users phone_verified=true: ${phoneVerified}`);
  console.log(`users BOTH verified: ${bothVerified}`);

  // is_admin
  const { count: adminCount } = await supabase
    .from("users")
    .select("*", { count: "exact", head: true })
    .eq("is_admin", true);
  console.log(`users is_admin=true: ${adminCount}`);

  // canonical_plans created in last 24 hours (cold-start activity)
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: recent24h } = await supabase
    .from("canonical_plans")
    .select("*", { count: "exact", head: true })
    .gte("created_at", yesterday);
  console.log(`canonical_plans created last 24h: ${recent24h}`);

  // canonical_promotion_events by source in last 24h
  const { count: events24h } = await supabase
    .from("canonical_promotion_events")
    .select("*", { count: "exact", head: true })
    .gte("created_at", yesterday)
    .eq("event_type", "admin_override");
  console.log(`canonical_promotion_events admin_override last 24h: ${events24h}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

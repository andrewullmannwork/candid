/**
 * control-B (S168) — RLS anon-exposure audit.
 *
 * Evidence artifact for the OPS.8 counsel review + a re-runnable anti-regression gate.
 * Probes the PUBLIC anon key (NEXT_PUBLIC_SUPABASE_ANON_KEY) against every user-scoped / PII
 * table and asserts it reads ZERO rows (RLS deny-by-default). Service-role row counts are shown
 * so a "0" on a table that actually holds data is meaningful (RLS working, not just empty).
 *
 * Exits NON-ZERO if any sensitive table is anon-readable (a live exposure) — wire into CI to
 * catch a future table that ships without RLS. Aggregate counts ONLY — never prints row data.
 *
 * Run: npx tsx scripts/security/rls-anon-audit.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), ".env.local") });
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * User-scoped + PII tables that MUST deny the public anon key. Derived SYSTEMATICALLY
 * (CREATE TABLE with user_id/firebase_uid) ∪ the Ing-E PII surfaces ∪ the insurer_appeals_*
 * family. REGENERATE when a new user-scoped/PII table is added — that is the anti-regression
 * contract this gate enforces.
 */
const SENSITIVE_TABLES = [
  // mig-151 codified (15)
  "benefit_corrections", "bill_parser_decisions", "canonical_correction_challenges",
  "canonical_divergence_review", "canonical_document_stability", "claim_discrepancies",
  "claims", "dispute_followups", "dispute_outcomes", "haiku_spend_tracking",
  "insurer_appeals_confirmations", "insurer_appeals_proposed_changes", "insurer_catalog",
  "parse_cost_events", "service_catalog_admin_review_queue",
  // already RLS-enabled in migrations (regression watch)
  "claim_line_items", "users", "documents", "insurance_plans", "plan_covered_services",
  "canonical_haiku_extractions", "document_extraction_log", "finding_dismissals",
  "compare_premium_observations", "concept_admin_review_queue", "haiku_budget_tracking",
  "parser_prompt_versions", "consent_events",
  // Ing-E PII service-role-only tables
  "pii_redaction_backfill_snapshot", "pii_audit_runs",
];

async function main() {
  const anon = createClient(URL, ANON);
  const svc = createClient(URL, SVC);

  const exposed: string[] = [];
  const missing: string[] = [];
  const rows: { t: string; anon: string; svc: number; verdict: string }[] = [];

  for (const t of SENSITIVE_TABLES) {
    const a = await anon.from(t).select("*", { count: "exact", head: true });
    const s = await svc.from(t).select("*", { count: "exact", head: true });
    if (s.error && /does not exist|find the table/i.test(s.error.message)) { missing.push(t); continue; }
    const anonCount = a.error ? null : (a.count ?? 0);
    const svcCount = s.count ?? 0;
    let verdict: string;
    if (a.error) verdict = "blocked (no grant)";
    else if ((anonCount ?? 0) > 0) { verdict = "*** EXPOSED ***"; exposed.push(t); }
    else verdict = svcCount > 0 ? "protected (RLS, has data)" : "protected (empty)";
    rows.push({ t, anon: a.error ? "ERR" : String(anonCount), svc: svcCount, verdict });
  }

  console.log("=== control-B RLS anon-exposure audit ===");
  console.log("table".padEnd(36), "anon".padStart(5), "svc".padStart(8), "  verdict");
  for (const r of rows) console.log(r.t.padEnd(36), r.anon.padStart(5), String(r.svc).padStart(8), " ", r.verdict);
  if (missing.length) console.log(`\n(skipped — not present: ${missing.join(", ")})`);
  console.log(`\nSENSITIVE tables checked: ${rows.length} | LIVE-EXPOSED: ${exposed.length}`);
  if (exposed.length) { console.error(`FAIL — anon can read: ${exposed.join(", ")}`); process.exit(1); }
  console.log("PASS — every sensitive table denies the public anon key.");
}

main().catch((e) => { console.error(e); process.exit(1); });

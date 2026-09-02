/**
 * dfy-operator-invariant — S330. Mock-Supabase contract for the DFY grant
 * primitive (operatorScoped) and the route-layer invariant (assertOperatorAction).
 *
 * Proves, independent of a database:
 *   - role: operator or admin admitted; anyone else refused (403), bad ids refused
 *   - grant: unknown matter 404; wrong status 409; not the holder 403 (an
 *     unclaimed matter says so); requireHolder:false is explicit
 *   - scoping BY CONSTRUCTION: every read carries the MEMBER's user_id AND the
 *     engagement's claim id; inserts are stamped with both; a table outside
 *     the grant is unreachable; inserts into id-keyed tables are refused
 *   - the composition proof: an executing act (transmit) is refused without the
 *     member's own ground_selected + letter_adopted record; a fact-logging act
 *     is not gated
 *   - the writers: claim only wins on an unclaimed row, release only by the
 *     holder, conditional patch loses when the precondition moved
 *   - the IP allowlist policy
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/dfy-operator-invariant.ts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  assertOperatorRole,
  operatorScoped,
  claimEngagement,
  releaseEngagement,
  patchEngagement,
  countHeldMatters,
  createEngagement,
  OperatorAccessError,
  OPERATOR_TABLE_CLAIM_COLUMN,
} from "../../../../src/lib/security/operator-scoped";
import {
  assertOperatorAction,
  loadCompositionProof,
  compositionComplete,
  OPERATOR_ACT_KINDS,
  COMPOSITION_GATED_ACTS,
} from "../../../../src/lib/dfy/operator-action";
import { CASE_EVENT_KINDS } from "../../../../src/lib/case/case-events";
import { ipAdmitted } from "../../../../src/lib/dfy/config";
import { DIRECT_USER_OWNED_TABLES } from "../../../../src/lib/security/user-scoped";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; console.error(`  ✗ ${name}`); } }
async function expectErr(name: string, fn: () => Promise<unknown>, status: number, code: string) {
  try { await fn(); check(`${name}: threw`, false); }
  catch (e) {
    const ok = e instanceof OperatorAccessError && e.status === status && e.code === code;
    check(`${name}: ${status} ${code}`, ok);
    if (!ok) console.error("    got:", e instanceof Error ? `${(e as OperatorAccessError).status ?? "?"} ${(e as OperatorAccessError).code ?? e.message}` : e);
  }
}

// ── The in-memory database ──────────────────────────────────────────────────
type Row = Record<string, unknown>;
const DB: Record<string, Row[]> = {
  users: [
    { id: "u1", is_operator: true, is_admin: false },
    { id: "a1", is_operator: false, is_admin: true },
    { id: "x1", is_operator: false, is_admin: false },
    { id: "m1" }, { id: "m2" },
  ],
  dfy_engagements: [
    { id: "e1", user_id: "m1", claim_id: "c1", status: "active", operator_user_id: "u1", payer: "member_paid", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
    { id: "e2", user_id: "m2", claim_id: "c2", status: "active", operator_user_id: null, payer: "member_paid", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
    { id: "e3", user_id: "m1", claim_id: "c3", status: "signed", operator_user_id: "u1", payer: "member_paid", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
    { id: "e4", user_id: "m1", claim_id: "c4", status: "terminated", operator_user_id: "u1", payer: "member_paid", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
    { id: "e5", user_id: "m2", claim_id: "c5", status: "active", operator_user_id: "u1", payer: "member_paid", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
  ],
  claims: [
    { id: "c1", user_id: "m1" }, { id: "c2", user_id: "m2" }, { id: "c5", user_id: "m2" }, { id: "c9", user_id: "m1" },
  ],
  claim_case_events: [
    { id: "ev1", user_id: "m1", claim_id: "c1", kind: "ground_selected" },
    { id: "ev2", user_id: "m1", claim_id: "c1", kind: "letter_adopted" },
    { id: "ev3", user_id: "m2", claim_id: "c5", kind: "letter_drafted" },
  ],
  profiles: [{ id: "p1", user_id: "m1", state: "CA" }],
  stripe_customers: [{ id: "s1", user_id: "m1" }],
};
const LOG: string[] = [];
let nextId = 100;

class Q {
  private filters: Array<{ op: string; col: string; val: unknown }> = [];
  private mode: "select" | "insert" | "update" | "delete" = "select";
  private values: unknown = null;
  private wantCount = false;
  private headOnly = false;
  private single = false;
  constructor(private table: string) {}
  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.mode === "select") LOG.push(`select ${this.table} ${cols ?? "*"}`);
    this.wantCount = !!opts?.count; this.headOnly = !!opts?.head; return this;
  }
  insert(rows: Row | Row[]) { this.mode = "insert"; this.values = rows; return this; }
  update(v: Row) { this.mode = "update"; this.values = v; return this; }
  delete() { this.mode = "delete"; return this; }
  eq(col: string, val: unknown) { this.filters.push({ op: "eq", col, val }); LOG.push(`eq ${this.table} ${col}=${String(val)}`); return this; }
  is(col: string, val: unknown) { this.filters.push({ op: "is", col, val }); return this; }
  in(col: string, vals: unknown[]) { this.filters.push({ op: "in", col, val: vals }); return this; }
  like(col: string, pat: string) { this.filters.push({ op: "like", col, val: pat }); return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { this.single = true; return this; }
  private matches(r: Row): boolean {
    return this.filters.every((f) =>
      f.op === "eq" || f.op === "is" ? r[f.col] === f.val
      : f.op === "in" ? (f.val as unknown[]).includes(r[f.col])
      : String(r[f.col] ?? "").startsWith(String(f.val).replace("%", "")));
  }
  then<T>(res: (v: unknown) => T, rej?: (e: unknown) => T) { return Promise.resolve(this.run()).then(res, rej); }
  private run() {
    const rows = (DB[this.table] ??= []);
    if (this.mode === "insert") {
      const arr = (Array.isArray(this.values) ? this.values : [this.values]) as Row[];
      const stamped = arr.map((r) => ({ id: `n${nextId++}`, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...r }));
      rows.push(...stamped); LOG.push(`insert ${this.table} ${JSON.stringify(stamped)}`);
      return { data: this.single ? stamped[0] : stamped, error: null };
    }
    if (this.mode === "update") {
      const hit = rows.filter((r) => this.matches(r));
      for (const r of hit) Object.assign(r, this.values as Row);
      return { data: this.single ? (hit[0] ?? null) : hit, error: null, count: hit.length };
    }
    const hit = rows.filter((r) => this.matches(r));
    if (this.wantCount && this.headOnly) return { data: null, error: null, count: hit.length };
    if (this.single) return { data: hit[0] ?? null, error: null };
    return { data: hit, error: null };
  }
}
const supabase = { from: (t: string) => new Q(t) } as unknown as SupabaseClient;

async function main() {
  // 1 — role
  check("u1 is an operator", (await assertOperatorRole(supabase, "u1")) === "operator");
  check("a1 is admitted as admin (same permissions on this section)", (await assertOperatorRole(supabase, "a1")) === "admin");
  await expectErr("x1 refused", () => assertOperatorRole(supabase, "x1"), 403, "not_operator");
  await expectErr("empty caller id refused", () => assertOperatorRole(supabase, ""), 403, "bad_id");

  // 2 — the grant
  const s1 = await operatorScoped(supabase, "u1", "e1");
  check("holder gets the scope", s1.engagement.id === "e1" && s1.role === "operator");
  await expectErr("admin who does not hold e1", () => operatorScoped(supabase, "a1", "e1"), 403, "not_holder");
  await expectErr("unclaimed e2 refused for acting", () => operatorScoped(supabase, "u1", "e2"), 403, "not_holder");
  try { await operatorScoped(supabase, "u1", "e2"); } catch (e) { check("unclaimed message says claim it first", e instanceof Error && /unclaimed/.test(e.message)); }
  check("requireHolder:false views an unclaimed matter", (await operatorScoped(supabase, "u1", "e2", { requireHolder: false })).engagement.id === "e2");
  await expectErr("signed e3 is not actionable by default", () => operatorScoped(supabase, "u1", "e3"), 409, "engagement_not_actionable");
  check("statuses override admits signed", (await operatorScoped(supabase, "u1", "e3", { statuses: ["signed"] })).engagement.status === "signed");
  await expectErr("unknown matter 404", () => operatorScoped(supabase, "u1", "nope"), 404, "engagement_not_found");

  // 3 — scoping by construction
  LOG.length = 0;
  const { data: claimRows } = await s1.table("claims").select("id");
  check("claims read returns only the engagement's claim", Array.isArray(claimRows) && claimRows.length === 1 && (claimRows[0] as Row).id === "c1");
  check("claims read carried the MEMBER's user_id", LOG.some((l) => l === "eq claims user_id=m1"));
  check("claims read carried the CLAIM id", LOG.some((l) => l === "eq claims id=c1"));
  LOG.length = 0;
  await s1.table("claim_case_events").insert({ kind: "dfy_status_called", payload: {} });
  const inserted = DB.claim_case_events[DB.claim_case_events.length - 1];
  check("event insert stamped user_id = member", inserted.user_id === "m1");
  check("event insert stamped claim_id = engagement's claim", inserted.claim_id === "c1");
  let threw = false;
  try { s1.table("claims").insert({}); } catch (e) { threw = e instanceof OperatorAccessError && e.code === "insert_not_granted"; }
  check("insert into an id-keyed table refused", threw);
  const { data: prof } = await s1.table("profiles").select("state").maybeSingle();
  check("profiles is member-scoped (no claim column)", (prof as Row | null)?.state === "CA");
  threw = false;
  try { (s1.table as (t: string) => unknown)("stripe_customers"); } catch (e) { threw = e instanceof OperatorAccessError && e.code === "table_not_granted"; }
  check("a table outside the grant is unreachable", threw);
  check("every granted table is a registered user-owned table", Object.keys(OPERATOR_TABLE_CLAIM_COLUMN).every((t) => (DIRECT_USER_OWNED_TABLES as readonly string[]).includes(t)));
  check("dfy_engagements is a registered user-owned table", (DIRECT_USER_OWNED_TABLES as readonly string[]).includes("dfy_engagements"));

  // 4 — the composition proof + the route-layer invariant
  const p1 = await loadCompositionProof(supabase, "m1", "c1");
  check("c1 proof complete", compositionComplete(p1));
  const p5 = await loadCompositionProof(supabase, "m2", "c5");
  check("c5 proof missing", !compositionComplete(p5));
  check("transmit on e1 (composed) is accepted", (await assertOperatorAction(supabase, "u1", "e1", "dfy_appeal_transmitted")).engagement.id === "e1");
  await expectErr("transmit on e5 (not composed) refused", () => assertOperatorAction(supabase, "u1", "e5", "dfy_appeal_transmitted"), 409, "composition_missing");
  check("status call on e5 is not composition-gated", (await assertOperatorAction(supabase, "u1", "e5", "dfy_status_called")).engagement.id === "e5");
  await expectErr("status call on unclaimed e2 refused", () => assertOperatorAction(supabase, "u1", "e2", "dfy_status_called"), 403, "not_holder");
  check("every operator act is a declared spine kind", OPERATOR_ACT_KINDS.every((k) => (CASE_EVENT_KINDS as readonly string[]).includes(k)));
  check("composition-gated acts are operator acts", [...COMPOSITION_GATED_ACTS].every((k) => (OPERATOR_ACT_KINDS as readonly string[]).includes(k)));
  check("transmit + designation + packet are gated", ["dfy_appeal_transmitted", "dfy_designation_submitted", "dfy_packet_prepared"].every((k) => COMPOSITION_GATED_ACTS.has(k as never)));

  // 5 — the writers
  check("held count = signed + active held by u1", (await countHeldMatters(supabase, "u1", ["signed", "active"])) === 3);
  const claimed = await claimEngagement(supabase, "u1", "e2");
  check("claim wins on an unclaimed row", claimed?.operator_user_id === "u1");
  check("claim loses on a held row", (await claimEngagement(supabase, "a1", "e1")) === null);
  check("release by a non-holder loses", (await releaseEngagement(supabase, "a1", "e1")) === null);
  check("release by the holder lands", (await releaseEngagement(supabase, "u1", "e1"))?.operator_user_id === null);
  check("conditional patch lands when the precondition holds", (await patchEngagement(supabase, "e3", { status: "signed" }, { status: "active" }))?.status === "active");
  check("conditional patch loses when the row moved", (await patchEngagement(supabase, "e4", { status: "active" }, { status: "completed" })) === null);
  const created = await createEngagement(supabase, "m1", { claim_id: "c9", payer: "member_paid", sponsor_ref: null, member_state: "CA", plan_classification: null });
  check("create stamps the member + eligibility_pending", created.engagement?.user_id === "m1" && created.engagement?.status === "eligibility_pending" && !created.conflict);

  // 6 — IP policy
  check("not enforced admits", ipAdmitted(null, { ipAllowlist: ["1.1.1.1"], ipAllowlistEnforced: false }));
  check("enforced + empty list admits", ipAdmitted("9.9.9.9", { ipAllowlist: [], ipAllowlistEnforced: true }));
  check("enforced + listed admits", ipAdmitted("1.1.1.1", { ipAllowlist: ["1.1.1.1"], ipAllowlistEnforced: true }));
  check("enforced + unlisted refuses", !ipAdmitted("2.2.2.2", { ipAllowlist: ["1.1.1.1"], ipAllowlistEnforced: true }));
  check("enforced + unknown ip refuses", !ipAdmitted(null, { ipAllowlist: ["1.1.1.1"], ipAllowlistEnforced: true }));

  // 7 — the migration widens the actor CHECK with 'operator' (the DB half of CaseEventActor)
  const mig = readFileSync(resolve(__dirname, "../../../../supabase/migrations/235_dfy_operator_lane.sql"), "utf8");
  check("mig 235 widens the actor CHECK", /CHECK \(actor IN \('user', 'system', 'backfill', 'operator'\)\)/.test(mig));
  check("mig 235 seeds dfy_operator_v1 OFF", /'dfy_operator_v1',\s*\n\s*false/.test(mig));

  console.log(`dfy-operator-invariant: ${pass}/${pass + fail} checks passed`);
  if (fail > 0) process.exit(1);
}
void main();

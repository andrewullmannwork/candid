import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ── B9 B1 class-backstop: ban raw `.from("<user-owned-table>")` outside the
// userScoped layer (src/lib/security/**). Forces all user-owned data access
// through userScoped()/assertOwnership()/selectOwnedParentIds() so the
// ownership filter cannot be forgotten (the audit-missed + future IDOR class).
//
// SYNC: this list must stay identical to DIRECT_USER_OWNED_TABLES +
// Object.keys(PARENT_JOIN_TABLES) in src/lib/security/user-scoped.ts. The B1
// contract harness asserts the two match — drift is either an un-guarded user
// table (silent IDOR surface) or a false lint error.
// Exported so scripts/check-user-table-registry-sync.mjs can assert this list
// stays identical to the layer's DIRECT_USER_OWNED_TABLES + PARENT_JOIN_TABLES
// (CI step; drift = a silent IDOR surface or a false lint error). ESLint reads
// only the default export, so this named export is inert to linting.
export const USER_OWNED_TABLES = [
  // direct user_id
  "claims",
  "insurance_plans",
  "documents",
  "dispute_outcomes",
  "claim_discrepancies",
  "profiles",
  "dispute_followups",
  "finding_dismissals",
  "benefit_corrections",
  "insurer_appeals_confirmations",
  "compare_premium_observations",
  "stripe_customers",
  "support_tickets",
  "consent_events",
  "subscription_events",
  "user_plan_cost_share_overrides", // Cost-Share v2 (mig 174), W3 route write
  "claim_case_events", // Timeline unification Phase 0 (mig 221), case-events emitter
  // parent-join children (no user_id) — banned raw; use selectOwnedParentIds()
  "claim_line_items",
  "plan_covered_services",
  "claim_accumulators", // Cost-Share v2 (mig 174) parent-join child; was added to the
  // layer's PARENT_JOIN_TABLES (S217 Step-3) but missed here — registry-sync drift fix.
];

/**
 * candid-security/no-raw-user-table-from — bans a literal `.from("<table>")`
 * call for any user-owned table. AST-precise (won't match strings/comments);
 * catches the read- AND write-IDOR shape (the table is named before the verb).
 * Skips Supabase Storage bucket access (`<x>.storage.from("documents")`) — same
 * literal, but object storage, not a user-table read (see create() below).
 * Limitation: only the string-literal arg form (a dynamic `.from(tableVar)` is
 * itself a code smell worth a manual flag).
 */
const noRawUserTableFrom = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban raw .from() on user-owned tables outside the userScoped layer (B9 B1 IDOR class-backstop).",
    },
    schema: [],
    messages: {
      banned:
        'Raw .from("{{table}}") is banned outside src/lib/security (B9 B1 IDOR class-backstop). Use userScoped(supabase, userId).table(...) for direct tables, or selectOwnedParentIds() for child tables. See src/lib/security/user-scoped.ts.',
    },
  },
  create(context) {
    const banned = new Set(USER_OWNED_TABLES);
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "from" &&
          node.arguments.length >= 1 &&
          node.arguments[0].type === "Literal" &&
          typeof node.arguments[0].value === "string" &&
          banned.has(node.arguments[0].value)
        ) {
          // Supabase Storage buckets share names with DB tables
          // (`supabase.storage.from("documents")`) but are object-storage
          // access, NOT a user-table read/write — never an IDOR surface. Skip
          // when the `.from` receiver is a `.storage` member so the bucket call
          // isn't a false positive. (First needed by the claims family's
          // source-document/url signed-URL route, S186 B1.2.)
          const receiver = callee.object;
          if (
            receiver.type === "MemberExpression" &&
            receiver.property.type === "Identifier" &&
            receiver.property.name === "storage"
          ) {
            return;
          }
          context.report({
            node,
            messageId: "banned",
            data: { table: node.arguments[0].value },
          });
        }
      },
    };
  },
};

/**
 * candid-security/no-direct-promotion-rpc — bans a direct `.rpc("apply_promotion_event")` call outside
 * the promotion-event.ts wrapper. apply_promotion_event is the canonical coverage writer; routing every
 * call through applyPromotionEvent() makes the REQUIRED CitePolicy (cite-grade provenance) un-bypassable
 * as the team scales (N1, mig 187 §14). AST-precise (won't match strings/comments).
 */
const noDirectPromotionRpc = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban direct .rpc('apply_promotion_event') outside promotion-event.ts (N1: force the typed CitePolicy wrapper).",
    },
    schema: [],
    messages: {
      banned:
        'Direct .rpc("apply_promotion_event") is banned — call applyPromotionEvent() from @/lib/parser/promotion-event so the required CitePolicy (cite-grade provenance) cannot be bypassed (N1, mig 187 §14).',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "rpc" &&
          node.arguments.length >= 1 &&
          node.arguments[0].type === "Literal" &&
          node.arguments[0].value === "apply_promotion_event"
        ) {
          context.report({ node, messageId: "banned" });
        }
      },
    };
  },
};

// ── S313: client flag reads go through the typed hook ──────────────────────
// `useFeatureFlag` takes an `ExposedFlag`, so an un-allowlisted key is a
// compile error. A raw `fetch("/api/feature-flags/<key>")` sidesteps that type
// entirely and reads as OFF forever if the key was never allowlisted — the
// S302 failure (`bill_totals_source_v1` ON in the database, built, tested,
// rendering nowhere) cost a full E2E round. The type guards the hook; this
// rule guards the bypass.
const noRawFeatureFlagFetch = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban raw fetch('/api/feature-flags/...') in client code — use the typed useFeatureFlag hook so an un-allowlisted key fails at compile time (S313).",
    },
    schema: [],
    messages: {
      banned:
        "Raw fetch(\"/api/feature-flags/…\") is banned — call useFeatureFlag() from @/lib/config/use-feature-flag. Its ExposedFlag parameter type is derived from the endpoint's own allowlist, so a key missing from EXPOSED_FLAGS is a compile error instead of a permanent silent OFF (S302/S313).",
    },
  },
  create(context) {
    const FLAG_ROUTE = "/api/feature-flags/";
    // Matches both fetch("/api/feature-flags/x") and the template form
    // fetch(`/api/feature-flags/${CONST}`) — the constant-indirection shape is
    // exactly what static key-checking cannot resolve, so ban the shape.
    const hitsFlagRoute = (arg) => {
      if (!arg) return false;
      if (arg.type === "Literal" && typeof arg.value === "string") {
        return arg.value.includes(FLAG_ROUTE);
      }
      if (arg.type === "TemplateLiteral") {
        return arg.quasis.some((q) => (q.value.cooked ?? "").includes(FLAG_ROUTE));
      }
      return false;
    };
    return {
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "fetch" &&
          hitsFlagRoute(node.arguments[0])
        ) {
          context.report({ node, messageId: "banned" });
        }
      },
    };
  },
};

const candidSecurityPlugin = {
  rules: {
    "no-raw-user-table-from": noRawUserTableFrom,
    "no-direct-promotion-rpc": noDirectPromotionRpc,
    "no-raw-feature-flag-fetch": noRawFeatureFlagFetch,
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Archived diagnostic snapshots — frozen one-off scripts retained for
    // historical traceability per S96 doc-organization convention. Linting
    // these would force perpetual cleanup of code that intentionally captures
    // a moment-in-time investigation.
    "scripts/findings/**",
    // Claude Code local tooling + git worktrees (.claude/worktrees/*). Gitignored
    // (.git/info/exclude) + never present on CI, but a local `eslint .` otherwise
    // recurses into each worktree's src/ + built .next/ output and reports
    // generated/duplicate "errors" that aren't the real project's. The
    // root-relative ".next/**" above does NOT cover nested worktree .next dirs.
    // The only committed file under .claude/ is launch.json (JSON, unlintable),
    // so ignoring .claude/** changes nothing about what CI lints.
    ".claude/**",
  ]),
  // ── B9 B1 user-table ownership guard ──────────────────────────────────────
  // Covers the whole API-route surface BY DEFAULT (new routes are guarded the
  // moment they're created — the IDOR-risk surface). `ignores` is the SHRINKING
  // migration ledger: permanent-exempt service-role paths + the user-facing
  // routes not yet moved onto the layer (each SAFE today via a hand-written
  // ownership filter; audited). B1.2 empties the "migration ledger" block to ∅.
  {
    files: ["src/app/api/**/*.ts"],
    ignores: [
      // — Permanent exempt: service-role legitimately un-scoped (parser
      //   pipeline / admin / cron / signed webhooks). NOT user-request-scoped. —
      "src/app/api/admin/**",
      "src/app/api/cron/**",
      "src/app/api/stripe/**",
      "src/app/api/slack/**",
      // email-forward = the Resend Inbound webhook (Svix-signed). A service-role
      //   ticket lookup by shortId + sender-email — there is NO authenticated
      //   user to scope to (same signed-webhook class as slack/** above).
      "src/app/api/email-forward/**",
      "src/app/api/documents/process-chunk/**",
      "src/app/api/documents/upload/**",
      // — B1 migration ledger (the account-adjacent codemod arc is COMPLETE → this
      //   block is now ∅; only the cross-WS F05/PR-D route remains below). —
      // FULLY MIGRATED onto the layer (covered by default; NO ledger entry):
      //   disputes/** (S183 PR-C + S185) · claims/** (S182 + S186) ·
      //   documents/{confirm-doc-type,reprocess} (S188) · account-cluster
      //   account/auth/billing/consent/legal/profile/support (S190 — userScoped.upsert
      //   + upsertOwnedChildren primitives) · plan+compare (S192 — compare/premium-
      //   observation + plan/{analyze,corrections,field,premium,reparse-field}, incl.
      //   the NEW adminScoped admin-authority accessor for corrections review/apply).
      // documents/process-chunk + documents/upload stay permanent-exempt (above).
      // ONLY remaining ledger entry = documents/status (F05/PR-D no-auth GET fix,
      // cross-workstream — the last B9 B1.2 route).
      "src/app/api/documents/status/**",
    ],
    plugins: { "candid-security": candidSecurityPlugin },
    rules: { "candid-security/no-raw-user-table-from": "error" },
  },
  // ── B9 B1 user-table ownership guard — src/lib (F12-class backstop, S194) ───
  // Extends the route guard to shared lib accessors. The B9 audit reviewed route
  // files but NOT shared `src/lib` helpers taking a raw request-supplied id —
  // exactly the class that let F12 (`loadFingerprintInputForClaim`) ship
  // un-audited (S183, found by accident). Covering `src/lib` BY DEFAULT means any
  // NEW lib accessor that reads a user-owned table is caught by construction.
  //
  // Unlike the route ledger (which drains to ∅), this ledger keeps a large
  // PERMANENT-EXEMPT tier: the parser pipeline + cross-user (Rule #5) aggregates
  // are service-role by nature — there is no authenticated user to scope to. The
  // MIGRATION-LEDGER tier is user-request-reached and was proven safe-by-upstream
  // ownership by the S194 triage (every read/write by a non-user_id id is gated
  // at the route via userScoped, or in the lib via an explicit user_id guard); it
  // drains onto the layer family-by-family as defense-in-depth.
  {
    files: ["src/lib/**/*.ts"],
    ignores: [
      // ── TIER 1 — PERMANENT-EXEMPT (service-role; never user-request-scoped) ──
      // parser pipeline + id-block cross-user aggregates:
      "src/lib/parser/**",
      // admin-authority accessors: cross-user BY DESIGN, reachable only behind
      // requireAdmin routes (same class as the parser promotion backfill):
      "src/lib/admin/unmapped-assign.ts",
      // claim-processing engine (runs during parse/persist; no request id):
      "src/lib/claims/**",
      // the ownership layer itself (holds the one legitimate raw `.from`):
      "src/lib/security/**",
      // plan/document parse pipeline (process-chunk / upload / cron context):
      "src/lib/plan/process-plan.ts",
      "src/lib/plan/process-eoc.ts",
      "src/lib/plan/extraction-dedup.ts",
      "src/lib/plan/reparse-fields-batch.ts",
      "src/lib/documents/process-document.ts",
      "src/lib/billing/truncation-telemetry.ts",
      // Rule #5 cross-user aggregates (k-anon dispute metrics):
      "src/lib/disputes/metrics.ts",
      "src/lib/disputes/accuracy.ts",
      "src/lib/disputes/outlier-eval.ts",
      // ── TIER 2 — MIGRATION LEDGER (user-request-reached; safe-by-upstream per
      //   the S194 triage; drain onto userScoped as defense-in-depth) ──────────
      "src/lib/audit/aca-coverage-fallback.ts",
      "src/lib/audit/coverage-loader.ts",
      "src/lib/audit/reaudit.ts",
      "src/lib/audit/zero-cost-share.ts",
      "src/lib/disputes/evidence-resolver.ts",
      "src/lib/disputes/insurer-appeals-upsert.ts",
      "src/lib/disputes/persist.ts",
      "src/lib/disputes/plan-context.ts",
      "src/lib/disputes/post-escalation-followup.ts",
      "src/lib/disputes/rerender.ts",
      "src/lib/email/onboarding-emails.ts",
      "src/lib/legal/evidence-compiler.ts",
      // confirmCanonicalMatch — PR-D-coupled: the documents/status caller has no
      // trustworthy userId to thread until F05 adds auth (S190 finding).
      "src/lib/plan/canonical-match.ts",
      "src/lib/plan/compare.ts",
      "src/lib/plan/coverage-targeting.ts",
      "src/lib/plan/reparse-field.ts",
      "src/lib/subscription/server.ts",
      // disputes/followups.ts — MIGRATED onto userScoped this session (S194
      //   proof-of-pattern); NOT ledgered (it is covered + clean).
    ],
    plugins: { "candid-security": candidSecurityPlugin },
    rules: { "candid-security/no-raw-user-table-from": "error" },
  },
  // ── N1 (mig 187 §14): force the typed CitePolicy wrapper for canonical promotions ──────────
  // apply_promotion_event writes canonical coverage; the wrapper applyPromotionEvent() makes the
  // cite-grade provenance decision REQUIRED at compile time. Banning the raw RPC call everywhere in
  // src/** except the wrapper makes that contract un-bypassable as the team scales. (Fixtures/tests
  // that exercise the RPC directly live under scripts/** and are outside this glob.)
  {
    files: ["src/**/*.ts"],
    ignores: ["src/lib/parser/promotion-event.ts"],
    plugins: { "candid-security": candidSecurityPlugin },
    rules: { "candid-security/no-direct-promotion-rpc": "error" },
  },
  // ── S313: one way to read a flag from the browser ──────────────────────────
  // Covers the client surface BY DEFAULT, so new code is guarded from birth.
  // `ignores` is the SHRINKING migration ledger: the 9 files holding the 13
  // pre-existing raw fetches. Every one of them is SAFE today — audited at
  // S313, all 13 keys are in EXPOSED_FLAGS and all 13 treat a missing
  // `enabled` as false — so this is named debt, not a live defect. Draining
  // the ledger means converting each call to useFeatureFlag(); the entry goes
  // away with the last raw fetch in that file. Empty ledger = class closed.
  //
  // Scoped to ALL of src, not just the .tsx files where today's 13 happen to
  // live: this repo's client hooks live under src/lib (there is no src/hooks),
  // so a future useSomethingFlag() there — or any .ts helper — would otherwise
  // slip a guard whose whole promise is that new code is covered by default.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      // THE sanctioned implementation — the hook every other caller must use.
      // Not debt; this one never leaves the list.
      "src/lib/config/use-feature-flag.ts",
      // ── the ledger ──
      "src/app/(app)/plan/page.tsx", // change_plan_v1 + onboarding_simplified_v1
      "src/app/(app)/disputes/page.tsx", // dispute_plan_pinning_v1
      "src/app/(app)/dashboard/page.tsx", // onboarding_simplified_v1 (via SIMPLIFIED_ONBOARDING_FLAG)
      "src/app/(app)/profile/page.tsx", // onboarding_simplified_v1 ×2 + the separate profile-dashboard route
      "src/app/(app)/compare/page.tsx", // compare_v2_redesign
      "src/app/auth/signup/page.tsx", // onboarding_simplified_v1 + TEST_PHONE_EXEMPTION_ENABLED
      "src/app/onboarding/page.tsx", // onboarding_simplified_v1
      "src/components/billing/SubscribeTrigger.tsx", // embedded_subscribe
      "src/components/claims/ClaimDetail.tsx", // dispute_plan_pinning_v1
    ],
    plugins: { "candid-security": candidSecurityPlugin },
    rules: { "candid-security/no-raw-feature-flag-fetch": "error" },
  },
]);

export default eslintConfig;

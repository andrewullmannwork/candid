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
const USER_OWNED_TABLES = [
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
  // parent-join children (no user_id) — banned raw; use selectOwnedParentIds()
  "claim_line_items",
  "plan_covered_services",
];

/**
 * candid-security/no-raw-user-table-from — bans a literal `.from("<table>")`
 * call for any user-owned table. AST-precise (won't match strings/comments);
 * catches the read- AND write-IDOR shape (the table is named before the verb).
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

const candidSecurityPlugin = {
  rules: { "no-raw-user-table-from": noRawUserTableFrom },
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
      "src/app/api/documents/process-chunk/**",
      "src/app/api/documents/upload/**",
      // — B1 migration ledger (SHRINKING → ∅ over B1.2). Unmigrated user-facing
      //   routes still using a raw `.from(<user-table>)` + hand-written filter. —
      "src/app/api/account/**",
      "src/app/api/auth/**",
      "src/app/api/billing/**",
      "src/app/api/compare/**",
      "src/app/api/consent/**",
      // disputes/generate MIGRATED onto the layer (S183 PR-C, F04+F09): covered
      // by default now. The rest of the disputes family stays ledgered until B1.2.
      "src/app/api/disputes/\\[disputeId\\]/**",
      "src/app/api/disputes/escalate/**",
      "src/app/api/disputes/followups/**",
      "src/app/api/disputes/insurer-appeals/**",
      "src/app/api/disputes/metrics/**",
      "src/app/api/disputes/outcome/**",
      "src/app/api/legal/**",
      "src/app/api/profile/**",
      "src/app/api/support/**",
      "src/app/api/claims/route.ts",
      "src/app/api/claims/\\[claimId\\]/**",
      "src/app/api/plan/analyze/**",
      "src/app/api/plan/corrections/**",
      "src/app/api/plan/field/**",
      "src/app/api/plan/premium/**",
      "src/app/api/plan/reparse-field/**",
      "src/app/api/documents/confirm-doc-type/**",
      "src/app/api/documents/reprocess/**",
      "src/app/api/documents/status/**",
    ],
    plugins: { "candid-security": candidSecurityPlugin },
    rules: { "candid-security/no-raw-user-table-from": "error" },
  },
]);

export default eslintConfig;

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * B1 — app-layer user-scoped data-access layer (the B9 IDOR class-backstop).
 *
 * WHY THIS EXISTS: `createServerClient()` is service-role and bypasses RLS, and
 * `middleware.ts` does not gate `/api/*`, so each API route SOLELY owns its
 * authorization. The B9 audit found 11 IDOR findings of ONE shape: a
 * service-role query + a request-supplied resource id + a missing/uneven
 * ownership filter. `userScoped()` makes the ownership filter the default that
 * is already applied the moment you name a user-owned table — so it cannot be
 * forgotten. The lint rule (`eslint.config.mjs` → `candid/no-raw-user-table-from`)
 * bans raw `.from("<user-owned-table>")` outside `src/lib/security/**` to force
 * all user-owned access through this layer.
 *
 * SCOPE: this is the APP-LAYER backstop. B2 (DB-enforced RLS) is the
 * un-bypassable backstop, deferred to B9-3 post-OPS.9 (no `SUPABASE_JWT_SECRET`
 * + no safe test DB pre-OPS.9). A determined bypass (raw SQL, an
 * `eslint-disable`) still works until B2 — the lint makes that loud, not
 * impossible. This layer also does NOT cover `.rpc()` internals (RPC ownership
 * is enforced inside the SQL function or by a caller-side `assertOwnership`
 * pre-check) — see the B1 design note.
 *
 * Registry source: the live PostgREST OpenAPI schema sweep (S182). Every
 * exposed public table was classified as direct-`user_id`, parent-join, or
 * exempt (telemetry / canonical / admin — never routed here). Keep
 * DIRECT_USER_OWNED_TABLES + PARENT_JOIN_TABLES in sync with the lint rule's
 * banned list in `eslint.config.mjs` (the contract harness asserts they match).
 */

/**
 * Tables with a direct `user_id` column that a user-facing route reads/writes
 * by a request-supplied id. The ownership filter is `user_id = <authed user>`.
 *
 * EXCLUDED on purpose (service-role legitimately un-scoped — the allowlist):
 *  - telemetry / cost: bill_parser_decisions, document_extraction_log,
 *    parse_cost_events, haiku_budget_tracking, haiku_spend_tracking
 *  - canonical extraction store: canonical_haiku_extractions
 * Those carry `user_id` for attribution/aggregation, not as an ownership-read
 * gate, and are written by parsers / read by admin — never a user request.
 */
export const DIRECT_USER_OWNED_TABLES = [
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
] as const;

export type DirectUserOwnedTable = (typeof DIRECT_USER_OWNED_TABLES)[number];

/**
 * Child tables with NO `user_id`, scoped via a parent that has one. Read via
 * `selectOwnedParentIds()` (resolve the owned parent ids, then filter the
 * children). The provable schema sweep (S182) found exactly these two among
 * the 9 FK-to-user children; the other 7 are admin-queue / canonical / k-anon
 * aggregate tables (exempt).
 */
export const PARENT_JOIN_TABLES = {
  claim_line_items: { parent: "claims", fk: "claim_id" },
  plan_covered_services: { parent: "insurance_plans", fk: "insurance_plan_id" },
} as const;

export type ParentJoinChildTable = keyof typeof PARENT_JOIN_TABLES;

const DIRECT_SET = new Set<string>(DIRECT_USER_OWNED_TABLES);

/** Fail closed: a null/empty userId would become `user_id IS NULL` and could
 *  surface orphan/seed rows. Never scope on a falsy owner. */
function assertUserId(userId: string): string {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error(
      "userScoped: userId must be a non-empty string (fail-closed ownership)",
    );
  }
  return userId;
}

type SelectOptions = {
  head?: boolean;
  count?: "exact" | "planned" | "estimated";
};

/**
 * Returns a per-table query factory whose every operation is filtered to
 * `userId`. SELECT/UPDATE/DELETE inject `.eq("user_id", userId)`; INSERT stamps
 * `user_id` on each row (overriding any caller-supplied value — you cannot
 * write as another user). Each method returns the real Supabase builder, so
 * `.eq/.in/.order/.maybeSingle/.single/...` chain natively and downstream row
 * shape is unchanged (op-equivalent for the owner).
 *
 *   userScoped(supabase, userId).table("claims").select("*").eq("id", id).maybeSingle()
 *   userScoped(supabase, userId).table("documents").update({ status }).eq("id", id)
 *   userScoped(supabase, userId).table("documents").delete().eq("id", id)
 *   userScoped(supabase, userId).table("support_tickets").insert(row)
 */
export function userScoped(supabase: SupabaseClient, userId: string) {
  const uid = assertUserId(userId);
  return {
    table(table: DirectUserOwnedTable) {
      if (!DIRECT_SET.has(table)) {
        // Defense-in-depth for a dynamic (non-literal) table arg that escapes
        // the compile-time union. Fail closed rather than silently un-scope.
        throw new Error(
          `userScoped.table: "${table}" is not a direct user_id table; use selectOwnedParentIds() for child tables`,
        );
      }
      return {
        // `columns as "*"`: this codebase has no generated Database types, so a
        // widened `columns: string` collapses the row type to GenericStringError,
        // while a `<Q extends string>` generic explodes tsc (GetResult recursion
        // over the table union). Casting to the "*" literal yields the permissive
        // (any-valued) row type the rest of the codebase already works with; the
        // real `columns` string is still sent to PostgREST at runtime.
        select(columns = "*", options?: SelectOptions) {
          return supabase.from(table).select(columns as "*", options).eq("user_id", uid);
        },
        update(values: Record<string, unknown>) {
          return supabase.from(table).update(values).eq("user_id", uid);
        },
        delete() {
          return supabase.from(table).delete().eq("user_id", uid);
        },
        insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
          const stamped = Array.isArray(rows)
            ? rows.map((r) => ({ ...r, user_id: uid }))
            : { ...rows, user_id: uid };
          return supabase.from(table).insert(stamped);
        },
      };
    },
  };
}

/**
 * Parent-join ownership: given request-supplied candidate parent ids, return
 * the subset the user owns. The caller then filters child rows
 * (`.in(fk, [...owned])`, or post-filters `rows.filter(r => owned.has(r[fk]))`
 * — composing with a parallel child fetch, no forced serialize). This is the
 * F09 pattern generalized, for the PARENT_JOIN_TABLES children. Fails closed on
 * empty input.
 */
export async function selectOwnedParentIds(
  supabase: SupabaseClient,
  userId: string,
  parentTable: string,
  candidateIds: (string | null | undefined)[],
): Promise<Set<string>> {
  const uid = assertUserId(userId);
  const unique = [...new Set(candidateIds.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Set();
  const { data } = await supabase
    .from(parentTable)
    .select("id")
    .eq("user_id", uid)
    .in("id", unique);
  return new Set((data ?? []).map((r) => r.id as string));
}

/**
 * Parent-join child READ: the lint-clean way for a route to read a child table
 * that has NO `user_id` (claim_line_items, plan_covered_services). Composes
 * selectOwnedParentIds (resolve the owned parent ids) + a child fetch scoped to
 * those ids (`.in(fk, ownedIds)`) — so the raw child `.from()` that the B1 lint
 * bans in routes lives ONCE here, inside the security layer. Scoped BY
 * CONSTRUCTION: a non-owned/foreign parent id is never resolved, so its children
 * are never fetched (not post-filtered away) — an attacker-supplied foreign
 * parent yields []. Fails closed (empty candidate set or no owned parent → []).
 *
 * `columns` is the PostgREST select string; embedded resources
 * (`service_catalog!inner(slug,name)`) are sent verbatim at runtime. The
 * `as "*"` cast is compile-time only — the same widening
 * userScoped().table().select() relies on (this codebase has no generated
 * Database types). The return type is left to inference (the untyped client
 * makes rows permissive), so callers keep their existing field access with no
 * `any` annotations and no new lint warnings.
 */
export async function selectOwnedChildren(
  supabase: SupabaseClient,
  userId: string,
  childTable: ParentJoinChildTable,
  candidateParentIds: (string | null | undefined)[],
  columns = "*",
) {
  const meta = PARENT_JOIN_TABLES[childTable];
  if (!meta) {
    // Defense-in-depth for a dynamic (non-literal) childTable that escapes the
    // compile-time union. Fail closed rather than do an unscoped child read.
    throw new Error(
      `selectOwnedChildren: "${childTable}" is not a parent-join child table`,
    );
  }
  const ownedParentIds = await selectOwnedParentIds(
    supabase,
    userId,
    meta.parent,
    candidateParentIds,
  );
  if (ownedParentIds.size === 0) return [];
  const { data } = await supabase
    .from(childTable)
    .select(columns as "*")
    .in(meta.fk, [...ownedParentIds]);
  return data ?? [];
}

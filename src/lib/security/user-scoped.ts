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
  // Cost-Share v2 (mig 174) — direct user_id; written by the user-facing
  // cost-share-override route (W3). Registered so a route write goes through
  // userScoped (the B9 backstop), not raw `.from()`.
  "user_plan_cost_share_overrides",
] as const;

export type DirectUserOwnedTable = (typeof DIRECT_USER_OWNED_TABLES)[number];

/**
 * Child tables with NO `user_id`, scoped via a parent that has one. Read via
 * `selectOwnedParentIds()` (resolve the owned parent ids, then filter the
 * children). The provable schema sweep (S182) found exactly two among the then-
 * 9 FK-to-user children (claim_line_items + plan_covered_services); the other 7
 * are admin-queue / canonical / k-anon aggregate tables (exempt).
 * `claim_accumulators` (mig 174, Cost-Share v2) is a new FK-to-claims child that
 * post-dates that sweep and is read by the user-facing claims routes → added.
 */
export const PARENT_JOIN_TABLES = {
  claim_line_items: { parent: "claims", fk: "claim_id" },
  plan_covered_services: { parent: "insurance_plans", fk: "insurance_plan_id" },
  claim_accumulators: { parent: "claims", fk: "claim_id" },
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
        // UPSERT — stamps user_id on every row (like insert, overriding any
        // caller-supplied value) AND requires "user_id" in the conflict target.
        // Without that guard an upsert whose onConflict is a non-owner natural
        // key could MATCH another user's row and overwrite it stamped as ours
        // (row-theft); requiring user_id in onConflict means a conflict can only
        // resolve within the owner's own rows. Fail-closed on a missing guard.
        // (First use: profiles save, onConflict "user_id", S190 B1.2.)
        upsert(
          values: Record<string, unknown> | Record<string, unknown>[],
          options: { onConflict: string; ignoreDuplicates?: boolean },
        ) {
          const targets = options.onConflict.split(",").map((s) => s.trim());
          if (!targets.includes("user_id")) {
            throw new Error(
              `userScoped.upsert: onConflict ("${options.onConflict}") must include ` +
                `"user_id" (fail-closed: an upsert may only dedupe within the owner's rows)`,
            );
          }
          const stamped = Array.isArray(values)
            ? values.map((r) => ({ ...r, user_id: uid }))
            : { ...values, user_id: uid };
          return supabase.from(table).upsert(stamped, options);
        },
      };
    },
  };
}

/**
 * Admin-authority cross-user access to a user-owned table (admin review queues,
 * admin apply-to-canonical). This is NOT caller-owned data, so it cannot use
 * userScoped() — that injects `.eq("user_id", <the admin>)` and would hide every
 * OTHER user's rows, breaking admin review. The B1 lint bans raw
 * `.from("<user-owned-table>")` in routes to kill the IDOR class; legitimate
 * admin cross-user access routes through HERE so it is explicit, centralized, and
 * ENFORCED — not a scattered `eslint-disable` whose only guard is a comment.
 *
 * Re-verifies `users.is_admin` for `adminUserId` and FAILS CLOSED (throws) if the
 * caller is not an admin — so the un-scoped builder can never reach a non-admin
 * even if a route's own is_admin gate is later removed or weakened. Returns the
 * raw Supabase builder (no `user_id` filter — an admin reads/writes across users
 * by authority); the caller chains `.select/.update/.delete/.eq/...` natively, so
 * a migrated call is op-equivalent to the prior raw `.from()`. `.table()` may be
 * called multiple times after a single verification (each yields a fresh
 * builder). First use: plan/corrections admin list/review/apply (S192 B1.2).
 *
 * The raw `.from()` the B1 lint bans in routes lives ONCE here, inside the
 * security layer (the lint covers `src/app/api/**` only). `table` is the same
 * DirectUserOwnedTable union userScoped uses — an admin acts by authority, so no
 * separate registry; the is_admin re-check is the access control.
 */
export async function adminScoped(supabase: SupabaseClient, adminUserId: string) {
  const uid = assertUserId(adminUserId);
  const { data } = await supabase
    .from("users")
    .select("is_admin")
    .eq("id", uid)
    .maybeSingle();
  if (data?.is_admin !== true) {
    throw new Error(
      "adminScoped: caller is not an admin (fail-closed cross-user authority)",
    );
  }
  return {
    table(table: DirectUserOwnedTable) {
      if (!DIRECT_SET.has(table)) {
        // Defense-in-depth for a dynamic (non-literal) table arg that escapes
        // the compile-time union. Fail closed rather than touch an unknown table.
        throw new Error(
          `adminScoped.table: "${table}" is not a registered user-owned table`,
        );
      }
      return supabase.from(table);
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

/**
 * Parent-join child WRITE: the lint-clean way for a route to UPDATE child-table
 * rows (claim_line_items, plan_covered_services) that have NO `user_id`, by their
 * own id. Verifies the parent is owned ONCE (selectOwnedParentIds), then applies
 * each update scoped BOTH by the child id AND `.eq(fk, parentId)` — belt-and-
 * suspenders so a child id from a different parent can never be written. Fails
 * closed: empty userId throws; a non-owned/foreign parent → 0 writes. The raw
 * child `.from()` the B1 lint bans in routes lives ONCE here, inside the layer.
 *
 * Symmetric to selectOwnedChildren (read): every child access in the codebase
 * happens where the parent id is already in scope (a dispute's claim_id, a
 * [claimId] path param), so this single PARENT-scoped write primitive covers the
 * write side with no by-raw-child-id variant. `updates` is `{ id, values }[]`;
 * returns the count actually written (op-equivalent: for an owner every update
 * lands, so the count equals the original per-row loop's success count).
 */
export async function updateOwnedChildren(
  supabase: SupabaseClient,
  userId: string,
  childTable: ParentJoinChildTable,
  parentId: string,
  updates: { id: string; values: Record<string, unknown> }[],
): Promise<{ updated: number }> {
  assertUserId(userId);
  const meta = PARENT_JOIN_TABLES[childTable];
  if (!meta) {
    // Defense-in-depth for a dynamic (non-literal) childTable that escapes the
    // compile-time union. Fail closed rather than do an unscoped child write.
    throw new Error(
      `updateOwnedChildren: "${childTable}" is not a parent-join child table`,
    );
  }
  if (updates.length === 0) return { updated: 0 };
  const ownedParentIds = await selectOwnedParentIds(supabase, userId, meta.parent, [
    parentId,
  ]);
  if (!ownedParentIds.has(parentId)) return { updated: 0 };
  let updated = 0;
  for (const { id, values } of updates) {
    const { error } = await supabase
      .from(childTable)
      .update(values)
      .eq("id", id)
      .eq(meta.fk, parentId);
    if (!error) updated += 1;
  }
  return { updated };
}

/**
 * Parent-join child DELETE, keyed by a natural (non-`id`) match (S292 4C).
 *
 * The other child primitives cover select / update / upsert; deletion had no
 * sanctioned path, so the merge-unwind route (`/api/plan/unwind-merge`, which
 * removes coverage cells a disowned document created) would otherwise have had
 * to reach for a raw `.from()` and an eslint-disable — turning a class-backstop
 * into a per-site exception. Adding the primitive keeps the ban absolute.
 *
 * Ownership is verified ONCE against the parent (selectOwnedParentIds), and the
 * fk is pinned on every delete, so a caller cannot delete a row belonging to a
 * plan it doesn't own even if it supplies a matching natural key. Fails closed:
 * empty userId throws; a foreign or unknown parent deletes NOTHING and reports
 * 0 rather than erroring, matching updateOwnedChildren's contract.
 *
 * `matches` are equality predicates on child columns (the 5-col coverage cell
 * key, for instance). An EMPTY match object is rejected: it would delete every
 * child row of the parent, which no caller should express by accident.
 */
export async function deleteOwnedChildren(
  supabase: SupabaseClient,
  userId: string,
  childTable: ParentJoinChildTable,
  parentId: string,
  matches: Record<string, string | number | boolean | null>[],
): Promise<{ deleted: number }> {
  assertUserId(userId);
  const meta = PARENT_JOIN_TABLES[childTable];
  if (!meta) {
    // Defense-in-depth for a dynamic (non-literal) childTable that escapes the
    // compile-time union. Fail closed rather than do an unscoped child delete.
    throw new Error(
      `deleteOwnedChildren: "${childTable}" is not a parent-join child table`,
    );
  }
  if (matches.length === 0) return { deleted: 0 };
  if (matches.some((m) => Object.keys(m).length === 0)) {
    throw new Error("deleteOwnedChildren: an empty match would delete every child row");
  }
  const ownedParentIds = await selectOwnedParentIds(supabase, userId, meta.parent, [parentId]);
  if (!ownedParentIds.has(parentId)) return { deleted: 0 };

  let deleted = 0;
  for (const match of matches) {
    let q = supabase.from(childTable).delete().eq(meta.fk, parentId);
    for (const [col, val] of Object.entries(match)) q = q.eq(col, val);
    const { error } = await q;
    if (!error) deleted += 1;
  }
  return { deleted };
}

/**
 * Parent-join child UPSERT: the lint-clean way for a route to UPSERT child-table
 * rows (plan_covered_services) that have NO `user_id`, keyed by a natural
 * conflict target. Verifies the parent is owned ONCE (selectOwnedParentIds),
 * stamps the fk = parentId on every row (override caller), then upserts with the
 * caller's onConflict. Requires the fk in the conflict target — symmetric to
 * userScoped.upsert's user_id guard — so a natural-key conflict can only resolve
 * within the (verified-owned) parent, never across plans. Fails closed: empty
 * userId throws; a non-owned/foreign parent → 0 writes. The raw child `.from()`
 * the B1 lint bans in routes lives ONCE here, inside the security layer.
 *
 * Symmetric to selectOwnedChildren/updateOwnedChildren: every child access in
 * the codebase happens where the parent id is already in scope (here: the user's
 * own active insurance_plan_id from their profile). First use: syncCopayServices
 * writing plan_covered_services copay rows, onConflict
 * "insurance_plan_id,service_id,place_of_service" (S190 B1.2). Returns the count
 * actually written (op-equivalent: for an owner every row lands).
 */
export async function upsertOwnedChildren(
  supabase: SupabaseClient,
  userId: string,
  childTable: ParentJoinChildTable,
  parentId: string,
  rows: Record<string, unknown>[],
  options: { onConflict: string; ignoreDuplicates?: boolean },
): Promise<{ upserted: number }> {
  assertUserId(userId);
  const meta = PARENT_JOIN_TABLES[childTable];
  if (!meta) {
    // Defense-in-depth for a dynamic (non-literal) childTable that escapes the
    // compile-time union. Fail closed rather than do an unscoped child upsert.
    throw new Error(
      `upsertOwnedChildren: "${childTable}" is not a parent-join child table`,
    );
  }
  const targets = options.onConflict.split(",").map((s) => s.trim());
  if (!targets.includes(meta.fk)) {
    throw new Error(
      `upsertOwnedChildren: onConflict ("${options.onConflict}") must include the ` +
        `parent fk "${meta.fk}" (fail-closed: a conflict may only resolve within the owned parent)`,
    );
  }
  if (rows.length === 0) return { upserted: 0 };
  const ownedParentIds = await selectOwnedParentIds(supabase, userId, meta.parent, [
    parentId,
  ]);
  if (!ownedParentIds.has(parentId)) return { upserted: 0 };
  const stamped = rows.map((r) => ({ ...r, [meta.fk]: parentId }));
  const { error } = await supabase.from(childTable).upsert(stamped, options);
  return { upserted: error ? 0 : stamped.length };
}

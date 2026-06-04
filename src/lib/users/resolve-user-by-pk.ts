import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolve a user row by its PRIMARY KEY (`users.id`).
 *
 * Convention (S163/S164): every `*.user_id` column — `documents.user_id`,
 * `insurance_plans.user_id`, `claims.user_id`, … — stores the **users PK**
 * (`users.id`), NOT the Firebase UID. The upload route writes `user.id`, so these
 * resolve by `.eq("id", …)`. Only the auth token's `decoded.uid` is a
 * `firebase_uid` (resolve THAT by `.eq("firebase_uid", …)`).
 *
 * This helper centralizes the convention so the defect class fixed in S163/S164
 * — `.eq("firebase_uid", <a users PK>)`, which never matches a UUID → silent
 * `null` → disabled flag reads / dropped flywheel votes / skipped enqueues —
 * cannot be reintroduced inline. It emits a warn-on-null sentinel (the G7
 * silent-regression guard) tagged with `ctx`, so each resolution seam stays
 * individually observable in logs.
 *
 * Never throws on the not-found path: returns `null` and the caller degrades
 * exactly as the pre-fix inline `?.email` / `?.id` chains did.
 *
 * @param supabase  server / service-role client
 * @param userPkId  the users PK (e.g. `doc.user_id`)
 * @param ctx       short call-site label for the sentinel (e.g. "process-plan:canonical_plans")
 */
export async function getUserContextByPk(
  supabase: SupabaseClient,
  userPkId: string | null | undefined,
  ctx: string,
): Promise<{ id: string; email: string | null } | null> {
  if (!userPkId) {
    console.warn(`[resolve-user-by-pk] ${ctx}: called with empty userPkId`);
    return null;
  }
  const { data, error } = await supabase
    .from("users")
    .select("id, email")
    .eq("id", userPkId)
    .maybeSingle();
  if (error) {
    console.warn(
      `[resolve-user-by-pk] ${ctx}: lookup error for users.id=${userPkId}: ${error.message}`,
    );
    return null;
  }
  if (!data) {
    console.warn(`[resolve-user-by-pk] ${ctx}: no users row for users.id=${userPkId}`);
    return null;
  }
  return { id: data.id as string, email: (data.email as string | null) ?? null };
}

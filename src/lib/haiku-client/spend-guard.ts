/**
 * S74.6 D-cost §F.1 + §F.3 — Haiku spend-guard wrapper.
 *
 * Wraps a Haiku call with a $10/user/day spend-cap check. The flow:
 *   1. Run the Haiku call (we don't have an accurate cost estimate before
 *      the call returns — the prompt-token count is an approximation only).
 *   2. POST-call, reserve the actual cost via `reserve_haiku_spend` RPC.
 *   3. If the reservation says `allowed: false` (cap tripped), fire the
 *      admin alert + log + return the call result tagged as paused.
 *      The cap is enforced as a CIRCUIT BREAKER, not a pre-call gate —
 *      the call that TRIPS the cap is allowed to complete; subsequent
 *      calls from the same user (same UTC day) are blocked.
 *
 * Why "post-call charge" instead of "pre-call check":
 *   - Anthropic's input/output token counts are only known after the call
 *     returns (cache hits, retries inside callHaikuWithCache, etc.).
 *   - Pre-call estimates over-allocate budget (we'd block calls that would
 *     have fit) or under-allocate (cap drift).
 *   - The single tripping call is bounded by the per-call Haiku call cost
 *     ceiling — typical D4 description-match calls are well under $0.05.
 *
 * Caller pattern:
 *   const result = await guardedHaikuCall(userId, () => callHaikuWithCache({...}));
 *   if (result.paused) return { skippedReason: 'budget_exceeded' };
 *   return { data: result.data, ... };
 */

import { createServerClient } from "../supabase/server";
import { notifyAdminCostCapExceeded } from "../notifications";

export interface HaikuCallTelemetry {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  warnings: string[];
}

export interface HaikuCallShape<T> extends HaikuCallTelemetry {
  data: T;
}

export interface GuardedHaikuResult<T> {
  data: T | null;
  costUsd: number;
  allowed: boolean;
  paused: boolean;
  reason?: string;
  /** Cumulative spend in USD after this call (server-reported). */
  newTotalUsd?: number;
  /** Effective cap (per-user override or default). */
  capUsd?: number;
}

interface ReserveSpendResponse {
  allowed: boolean;
  reason?: string;
  new_total_usd?: number;
  cap_usd?: number;
  attempted_total?: number;
  paused_at?: string;
  pause_reason?: string;
}

/**
 * Run a Haiku call and post-charge the resulting cost against the user's
 * daily spend cap. The Haiku call ALWAYS runs (no pre-call gate) — the
 * cap acts as a circuit breaker: the call that pushes the user over the
 * cap is allowed to complete, but the RPC marks the user as paused so
 * subsequent calls within the UTC day short-circuit.
 *
 * Returns `paused: true` (with `data: null`) only when the user is ALREADY
 * paused at call time. The single tripping call still returns its data
 * (cost has been spent regardless).
 */
export async function guardedHaikuCall<T>(
  userId: string,
  callFn: () => Promise<HaikuCallShape<T>>,
  options: { capUsd?: number; userEmail?: string | null } = {},
): Promise<GuardedHaikuResult<T>> {
  if (!userId) {
    // No user context (e.g., admin-driven path) — bypass the cap entirely.
    // Caller is responsible for verifying admin authority elsewhere.
    const result = await callFn();
    return {
      data: result.data,
      costUsd: result.costUsd,
      allowed: true,
      paused: false,
    };
  }

  const supabase = createServerClient();

  // §F.1 fast-path: check the existing paused state with a $0 reservation
  // attempt. If already paused, short-circuit BEFORE spending. The post-call
  // re-check below catches the actual cap-tripping call.
  const { data: precheckData, error: precheckErr } = await supabase.rpc("reserve_haiku_spend", {
    p_user_id: userId,
    p_call_cost_usd: 0,
    p_cap_usd: options.capUsd ?? 10.0,
  });
  if (!precheckErr && precheckData) {
    const pre = precheckData as ReserveSpendResponse;
    if (pre.allowed === false && pre.reason === "already_paused") {
      return {
        data: null,
        costUsd: 0,
        allowed: false,
        paused: true,
        reason: pre.pause_reason ?? "already_paused",
        capUsd: pre.cap_usd,
      };
    }
  }

  // Run the call.
  let result: HaikuCallShape<T>;
  try {
    result = await callFn();
  } catch (err) {
    return {
      data: null,
      costUsd: 0,
      allowed: false,
      paused: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // Post-call: record the actual cost. If this push trips the cap, the RPC
  // marks paused_at + we fire the admin alert. The current call's data is
  // returned to the caller regardless — the cap acts as a circuit breaker.
  const { data, error } = await supabase.rpc("reserve_haiku_spend", {
    p_user_id: userId,
    p_call_cost_usd: result.costUsd,
    p_cap_usd: options.capUsd ?? 10.0,
  });

  if (error) {
    console.warn("[spend-guard] reserve_haiku_spend RPC failed", error);
    return {
      data: result.data,
      costUsd: result.costUsd,
      allowed: true,
      paused: false,
    };
  }

  const resp = data as ReserveSpendResponse;
  if (resp.allowed === false) {
    // §F.3 admin alert. Non-blocking on Slack-down (Slack helper swallows
    // errors). The pause is already written in the RPC — admin recovers
    // via A4 unfreeze later.
    if (resp.reason === "spend_cap_exceeded") {
      console.error(
        `[spend-guard] daily spend cap tripped: user=${userId} cap=$${resp.cap_usd} attempted=$${resp.attempted_total}`,
      );
      void notifyAdminCostCapExceeded({
        userId,
        userEmail: options.userEmail ?? null,
        reason: resp.reason,
        capUsd: Number(resp.cap_usd ?? options.capUsd ?? 10),
        attemptedTotalUsd: Number(resp.attempted_total ?? result.costUsd),
      });
    }
    // Even when paused, return the call's data — it already spent the cost.
    return {
      data: result.data,
      costUsd: result.costUsd,
      allowed: false,
      paused: true,
      reason: resp.reason,
      capUsd: resp.cap_usd,
    };
  }

  return {
    data: result.data,
    costUsd: result.costUsd,
    allowed: true,
    paused: false,
    newTotalUsd: resp.new_total_usd,
    capUsd: resp.cap_usd,
  };
}

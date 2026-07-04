#!/usr/bin/env tsx
/**
 * Admin-login hardening fixture (B9-2; Ship Gate G4; manually re-runnable).
 *
 * Tests the TS SEAM ONLY, with a mocked Supabase client + mocked fetch:
 *   - consumeRateLimit row→ConsumeResult mapping (allow / window-cap / lockout)
 *   - fail-OPEN on rpc error AND on throw
 *   - consumeTiers ordering (minute-first; first limiting tier wins; limitedWindowSeconds)
 *   - registerLoginFailure lock/no-lock/non-fatal
 *   - loadAdminLoginPolicy clamping + fail-safe defaults; clampInt bounds
 *   - buildAdminLockoutSlackText full-context body + channel override
 *   - notifyAdminLockout non-fatal (success, api-error, throw, missing-token skip)
 *   - ipBucketKey format
 *
 * NOT tested here (would be testing a mock, not the system): the plpgsql window/
 * lockout logic in mig 197. Its real proof is the post-apply PROD RPC burst smoke
 * (allow → cap → lock → auto-expire) against service-role.
 *
 * Run: npx tsx scripts/admin-login-hardening-fixture.ts
 * CI wiring deferred per the existing Ship Gate convention (block_ship_gate.md).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  consumeRateLimit,
  consumeTiers,
  registerLoginFailure,
  clearRateLimit,
  ipBucketKey,
} from "../src/lib/security/durable-rate-limit";
import { loadAdminLoginPolicy, clampInt } from "../src/lib/security/admin-login-hardening";
import {
  buildAdminLockoutSlackText,
  notifyAdminLockout,
  resolveSecurityChannelId,
  type AdminLockoutPayload,
} from "../src/lib/security/admin-login-slack";

let assertionsRun = 0;
let failures = 0;
function assert(cond: boolean, label: string): void {
  assertionsRun++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

// ── Mock helpers ───────────────────────────────────────────────────────────
function rpcClient(
  handler: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown },
): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => handler(fn, args),
  } as unknown as SupabaseClient;
}

function throwingRpcClient(): SupabaseClient {
  return {
    rpc: async () => {
      throw new Error("supabase down");
    },
  } as unknown as SupabaseClient;
}

function fromClient(result: { data: unknown; error: unknown }): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: async () => result,
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

const FUTURE_ISO = "2999-01-01T00:00:00.000Z";
const WINDOW = { windowSeconds: 900, maxAttempts: 10 };

async function main(): Promise<void> {
  // ── consumeRateLimit mapping ──────────────────────────────────────────────
  console.log("consumeRateLimit mapping:");
  {
    const c = rpcClient(() => ({
      data: [{ allowed: true, retry_after_seconds: 0, locked_until: null }],
      error: null,
    }));
    const r = await consumeRateLimit("k", WINDOW, c);
    assert(
      r.allowed && r.retryAfterSeconds === 0 && r.lockedUntil === null && r.limitedWindowSeconds === undefined,
      "allowed row → allowed, no window tag",
    );
  }
  {
    const c = rpcClient(() => ({
      data: [{ allowed: false, retry_after_seconds: 42, locked_until: null }],
      error: null,
    }));
    const r = await consumeRateLimit("k", WINDOW, c);
    assert(
      !r.allowed && r.retryAfterSeconds === 42 && r.lockedUntil === null && r.limitedWindowSeconds === 900,
      "window-cap denial tags limitedWindowSeconds",
    );
  }
  {
    const c = rpcClient(() => ({
      data: [{ allowed: false, retry_after_seconds: 900, locked_until: FUTURE_ISO }],
      error: null,
    }));
    const r = await consumeRateLimit("k", WINDOW, c);
    assert(
      !r.allowed && r.lockedUntil instanceof Date && r.limitedWindowSeconds === undefined,
      "lockout denial maps lockedUntil, no window tag",
    );
  }

  // ── fail-OPEN ─────────────────────────────────────────────────────────────
  console.log("fail-open:");
  {
    const c = rpcClient(() => ({ data: null, error: { message: "boom" } }));
    const r = await consumeRateLimit("k", WINDOW, c);
    assert(r.allowed === true, "rpc error → fail OPEN (allowed)");
  }
  {
    const r = await consumeRateLimit("k", WINDOW, throwingRpcClient());
    assert(r.allowed === true, "rpc throw → fail OPEN (allowed)");
  }
  {
    const r = await consumeRateLimit("k", WINDOW, rpcClient(() => ({ data: [], error: null })));
    assert(r.allowed === true, "empty rows → fail OPEN (allowed)");
  }

  // ── consumeTiers ordering ─────────────────────────────────────────────────
  console.log("consumeTiers ordering:");
  const TIERS = [
    { windowSeconds: 60, maxAttempts: 3 },
    { windowSeconds: 3600, maxAttempts: 10 },
  ];
  {
    // minute allows, hour blocks → hour reason
    const c = rpcClient((_fn, args) => {
      const key = String(args.p_bucket_key);
      return key.endsWith(":60")
        ? { data: [{ allowed: true, retry_after_seconds: 0, locked_until: null }], error: null }
        : { data: [{ allowed: false, retry_after_seconds: 100, locked_until: null }], error: null };
    });
    const r = await consumeTiers("reset-pw:ip:1.2.3.4", TIERS, c);
    assert(!r.allowed && r.limitedWindowSeconds === 3600, "hour tier blocks → limitedWindowSeconds 3600");
  }
  {
    // minute blocks first → minute reason (hour never consulted)
    const c = rpcClient((_fn, args) => {
      const key = String(args.p_bucket_key);
      return key.endsWith(":60")
        ? { data: [{ allowed: false, retry_after_seconds: 30, locked_until: null }], error: null }
        : { data: [{ allowed: true, retry_after_seconds: 0, locked_until: null }], error: null };
    });
    const r = await consumeTiers("reset-pw:ip:x", TIERS, c);
    assert(!r.allowed && r.limitedWindowSeconds === 60, "minute tier blocks first → limitedWindowSeconds 60");
  }
  {
    const c = rpcClient(() => ({
      data: [{ allowed: true, retry_after_seconds: 0, locked_until: null }],
      error: null,
    }));
    const r = await consumeTiers("k", TIERS, c);
    assert(r.allowed === true, "all tiers allow → allowed");
  }

  // ── registerLoginFailure ──────────────────────────────────────────────────
  console.log("registerLoginFailure:");
  {
    const locked = await registerLoginFailure(
      "k",
      { lockoutThreshold: 5, lockoutSeconds: 900 },
      rpcClient(() => ({ data: FUTURE_ISO, error: null })),
    );
    assert(locked instanceof Date, "returns lock Date when threshold crossed");
  }
  {
    const notLocked = await registerLoginFailure(
      "k",
      { lockoutThreshold: 5, lockoutSeconds: 900 },
      rpcClient(() => ({ data: null, error: null })),
    );
    assert(notLocked === null, "returns null when not yet locked");
  }
  {
    const r = await registerLoginFailure(
      "k",
      { lockoutThreshold: 5, lockoutSeconds: 900 },
      rpcClient(() => ({ data: null, error: { message: "x" } })),
    );
    assert(r === null, "non-fatal on error → null");
  }

  // ── clearRateLimit (non-fatal) ────────────────────────────────────────────
  console.log("clearRateLimit:");
  {
    let ok = true;
    try {
      await clearRateLimit("k", throwingRpcClient());
    } catch {
      ok = false;
    }
    assert(ok, "never throws (best-effort) even when rpc throws");
  }

  // ── clampInt ──────────────────────────────────────────────────────────────
  console.log("clampInt:");
  assert(clampInt(0, 1, 100, 10) === 1, "below min → min");
  assert(clampInt(5, 1, 100, 10) === 5, "in range → value");
  assert(clampInt(200, 1, 100, 10) === 100, "above max → max");
  assert(clampInt("x", 1, 100, 10) === 10, "non-number → fallback");
  assert(clampInt(3.7, 1, 100, 10) === 3, "floors fractional");

  // ── loadAdminLoginPolicy ──────────────────────────────────────────────────
  console.log("loadAdminLoginPolicy:");
  {
    const c = fromClient({
      data: {
        config: {
          max_attempts: 0,
          window_seconds: 5,
          lockout_threshold: 99999,
          lockout_seconds: 900,
          turnstile_required: false,
        },
      },
      error: null,
    });
    const p = await loadAdminLoginPolicy(c);
    assert(p.maxAttempts === 1, "max_attempts 0 clamps up to 1");
    assert(p.windowSeconds === 30, "window_seconds 5 clamps up to 30");
    assert(p.lockoutThreshold === 10000, "lockout_threshold 99999 clamps to 10000");
    assert(p.turnstileRequired === false, "turnstile_required=false honored (escape hatch)");
  }
  {
    const p = await loadAdminLoginPolicy(fromClient({ data: { config: null }, error: null }));
    assert(p.maxAttempts === 10 && p.turnstileRequired === true, "null config → safe defaults");
  }
  {
    const p = await loadAdminLoginPolicy(throwingRpcClient()); // no .from → throws → caught
    assert(
      p.windowSeconds === 900 && p.lockoutThreshold === 5 && p.turnstileRequired === true,
      "load error → safe defaults (fail-safe)",
    );
  }

  // ── Slack builder + channel ───────────────────────────────────────────────
  console.log("Slack builder + channel:");
  const payload: AdminLockoutPayload = {
    route: "/api/auth/admin-password",
    environment: "production",
    clientIp: "203.0.113.44",
    lockoutThreshold: 5,
    lockedUntil: new Date(FUTURE_ISO),
    lockoutSeconds: 900,
    occurredAt: new Date("2026-07-03T21:00:00.000Z"),
  };
  {
    const text = buildAdminLockoutSlackText(payload);
    assert(text.includes("/api/auth/admin-password"), "body has route");
    assert(text.includes("203.0.113.44"), "body has client IP");
    assert(text.includes("5 consecutive"), "body has failure threshold");
    assert(text.includes("2999-01-01"), "body has locked-until timestamp");
    assert(text.toLowerCase().includes("auto-expires"), "body reassures auto-expiry (no permanent lock)");
    assert(text.toLowerCase().includes("distributed"), "body hints at distributed-attempt watch");
    assert(text.includes("turnstile_required"), "body names the escape-hatch config");
  }
  {
    delete process.env.SLACK_SECURITY_CHANNEL_ID;
    assert(resolveSecurityChannelId() === "C0BEX5FQHJP", "channel default = security channel");
    process.env.SLACK_SECURITY_CHANNEL_ID = "COVERRIDE1";
    assert(resolveSecurityChannelId() === "COVERRIDE1", "channel env override honored");
    delete process.env.SLACK_SECURITY_CHANNEL_ID;
  }

  // ── notifyAdminLockout non-fatal ──────────────────────────────────────────
  console.log("notifyAdminLockout (non-fatal):");
  {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    let captured: { channel?: string; text?: string } | null = null;
    const okFetch = (async (_url: string, opts: { body: string }) => {
      captured = JSON.parse(opts.body) as { channel?: string; text?: string };
      return { ok: true, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;
    await notifyAdminLockout(payload, okFetch);
    assert(
      captured !== null &&
        (captured as { channel?: string }).channel === "C0BEX5FQHJP" &&
        ((captured as { text?: string }).text ?? "").includes("203.0.113.44"),
      "posts to security channel with full body",
    );
  }
  {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const errFetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: "server_error" }),
    })) as unknown as typeof fetch;
    let threw = false;
    try {
      await notifyAdminLockout(payload, errFetch);
    } catch {
      threw = true;
    }
    assert(!threw, "non-fatal on Slack API error");
  }
  {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const throwFetch = (async () => {
      throw new Error("net");
    }) as unknown as typeof fetch;
    let threw = false;
    try {
      await notifyAdminLockout(payload, throwFetch);
    } catch {
      threw = true;
    }
    assert(!threw, "non-fatal on fetch throw");
  }
  {
    delete process.env.SLACK_BOT_TOKEN;
    let called = false;
    const spyFetch = (async () => {
      called = true;
      return { ok: true, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;
    await notifyAdminLockout(payload, spyFetch);
    assert(called === false, "skips (no fetch) when SLACK_BOT_TOKEN unset");
  }

  // ── ipBucketKey ───────────────────────────────────────────────────────────
  console.log("ipBucketKey:");
  assert(ipBucketKey("admin-pw", "1.2.3.4") === "admin-pw:ip:1.2.3.4", "formats scope:ip:addr");
  assert(ipBucketKey("admin-pw", null) === "admin-pw:ip:unknown", "null IP → :unknown");

  // ── summary ───────────────────────────────────────────────────────────────
  console.log(`\n${assertionsRun} assertions, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("fixture crashed:", err);
  process.exit(1);
});

/**
 * S320 — TURNSTILE SESSION-ESTABLISHED FIXTURE (pure, offline, CI-wired).
 *
 * Locks the one-check-per-session contract: every account is born through a
 * Turnstile-verified sync, so when `turnstile_enforcement_v1`'s config enables
 * it, protected per-call routes accept a session younger than the TTL in
 * place of a fresh token. The parse must fail TOWARD challenging: any
 * missing/mistyped config key restores per-call tokens, never widens
 * acceptance; a null/garbage created_at is never established.
 *
 *   config absent/garbage      -> skip OFF (byte-identical pre-S320 behavior)
 *   partial config             -> missing key falls to its default
 *   fresh account + skip ON    -> established
 *   stale account + skip ON    -> NOT established (TTL exact boundary)
 *   any account + skip OFF     -> NOT established
 *   null / future created_at   -> NOT established
 *
 * Offline: pure functions, fixed clock. No DB, no network, no env.
 */
import {
  resolveTurnstileSessionConfig,
  isTurnstileSessionEstablished,
  DEFAULT_TURNSTILE_SESSION_CONFIG,
} from "@/lib/security/turnstile";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}`);
  }
}

console.log("— config parsing fails toward challenging —");
check("null config → skip OFF", resolveTurnstileSessionConfig(null).sessionEstablishedSkip === false);
check("string config → skip OFF", resolveTurnstileSessionConfig("on").sessionEstablishedSkip === false);
check(
  "empty object → defaults",
  JSON.stringify(resolveTurnstileSessionConfig({})) === JSON.stringify(DEFAULT_TURNSTILE_SESSION_CONFIG),
);
check(
  "truthy-but-not-true skip → OFF",
  resolveTurnstileSessionConfig({ session_established_skip: 1 }).sessionEstablishedSkip === false,
);
const onCfg = resolveTurnstileSessionConfig({
  session_established_skip: true,
  session_established_ttl_minutes: 60,
});
check("full config parses", onCfg.sessionEstablishedSkip === true && onCfg.sessionTtlMinutes === 60);
check(
  "skip ON + bad ttl → default ttl",
  resolveTurnstileSessionConfig({ session_established_skip: true, session_established_ttl_minutes: -5 })
    .sessionTtlMinutes === DEFAULT_TURNSTILE_SESSION_CONFIG.sessionTtlMinutes,
);

console.log("— establishment derivation —");
const now = new Date("2026-08-19T20:00:00Z");
const mins = (n: number) => new Date(now.getTime() - n * 60_000);
check("fresh (5m) + skip ON → established", isTurnstileSessionEstablished(mins(5), onCfg, now));
check("59m + 60m ttl → established", isTurnstileSessionEstablished(mins(59), onCfg, now));
check("exactly at ttl → NOT established", !isTurnstileSessionEstablished(mins(60), onCfg, now));
check("stale (61m) → NOT established", !isTurnstileSessionEstablished(mins(61), onCfg, now));
check(
  "fresh + skip OFF → NOT established",
  !isTurnstileSessionEstablished(mins(5), DEFAULT_TURNSTILE_SESSION_CONFIG, now),
);
check("null created_at → NOT established", !isTurnstileSessionEstablished(null, onCfg, now));
check("garbage created_at → NOT established", !isTurnstileSessionEstablished("not-a-date", onCfg, now));
check(
  "future created_at → NOT established",
  !isTurnstileSessionEstablished(new Date(now.getTime() + 60_000), onCfg, now),
);
check(
  "ISO-string created_at parses",
  isTurnstileSessionEstablished(mins(5).toISOString(), onCfg, now),
);

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length > 0) {
  console.error(`FAILED: ${fails.join(" | ")}`);
  process.exit(1);
}

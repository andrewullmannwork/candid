/**
 * scripts/activation-stamp-guard.mjs — S319 mig 231 stamp contract.
 *
 * Every write that flips a plan active (`is_active: true` in an
 * insurance_plans .update()/.insert() payload) MUST also stamp
 * `activated_at` in the same payload — the activation record (mig 231) is
 * only as complete as its writers, and a future seam that forgets the stamp
 * would silently starve every "has the user moved on?" rule (stranded
 * Gate 4 today; anything built on the fact tomorrow).
 *
 * Static scan, same family as security-layer-contract.mjs /
 * canonical-link-pair-guard.mjs: for each `is_active: true` occurrence in
 * src/ (payload syntax only — `.eq("is_active", true)` filters don't match
 * the pattern), require `activated_at` within the surrounding 400 chars.
 * Exits 1 listing offenders. No runner, CI step per the S185 convention.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

/** Recursively collect .ts/.tsx files under src/. */
function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const offenders = [];
// S320 — the regex now also catches VARIABLE payloads (`is_active: shouldActivate`)
// and EXPRESSION payloads (`is_active: !isComparisonUpload` — run-4 shipped an
// active plan with activated_at null through exactly that form): extraction-dedup
// and process-plan both evaded the literal-true scan for months. `false`
// (deactivation) and `boolean` (type annotations) are excluded.
const ACTIVATION_RE = /is_active:\s*(?!false\b)(?!boolean\b)[!A-Za-z_$true][\w$]*/g;
const finalizeOffenders = [];
for (const f of files(SRC)) {
  const text = readFileSync(f, "utf8");
  let m;
  let hasActivationWrite = false;
  ACTIVATION_RE.lastIndex = 0;
  while ((m = ACTIVATION_RE.exec(text)) !== null) {
    hasActivationWrite = true;
    const start = Math.max(0, m.index - 200);
    const windowText = text.slice(start, m.index + 400);
    if (!windowText.includes("activated_at")) {
      const line = text.slice(0, m.index).split("\n").length;
      offenders.push(`${f.replace(ROOT, "")}:${line}`);
    }
  }
  // S320 — the claim-follow contract: any file that flips a plan active must
  // run finalizePlanActivation (adopt + follow-deactivated as ONE step). The
  // /check SBC-upload door shipped activation-without-adoption for weeks —
  // every bill-before-plan claim stayed unlinked, plan costs never flowed —
  // because the seam inventory was maintained by memory. The helper's home
  // module is exempt (it defines the family; it writes no activations).
  if (
    hasActivationWrite &&
    !f.endsWith("claim-plan-link.ts") &&
    !text.includes("finalizePlanActivation")
  ) {
    finalizeOffenders.push(f.replace(ROOT, ""));
  }
}

if (offenders.length > 0 || finalizeOffenders.length > 0) {
  if (offenders.length > 0) {
    console.error(
      "activation-stamp-guard: plan activation written WITHOUT `activated_at` (mig 231 contract):",
    );
    for (const o of offenders) console.error("  " + o);
  }
  if (finalizeOffenders.length > 0) {
    console.error(
      "activation-stamp-guard: activation writer file MISSING finalizePlanActivation (S320 claim-follow contract):",
    );
    for (const o of finalizeOffenders) console.error("  " + o);
  }
  console.error(
    "Every activation writer stamps activated_at in the same payload (mig 231) AND runs finalizePlanActivation (S320).",
  );
  process.exit(1);
}
console.log(
  "activation-stamp-guard: all activation writers stamp activated_at + run finalizePlanActivation ✓",
);

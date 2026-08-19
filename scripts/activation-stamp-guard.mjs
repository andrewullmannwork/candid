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
for (const f of files(SRC)) {
  const text = readFileSync(f, "utf8");
  const re = /is_active:\s*true/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - 200);
    const windowText = text.slice(start, m.index + 200);
    if (!windowText.includes("activated_at")) {
      const line = text.slice(0, m.index).split("\n").length;
      offenders.push(`${f.replace(ROOT, "")}:${line}`);
    }
  }
}

if (offenders.length > 0) {
  console.error(
    "activation-stamp-guard: `is_active: true` written WITHOUT `activated_at` (mig 231 contract):",
  );
  for (const o of offenders) console.error("  " + o);
  console.error(
    "Every activation writer stamps activated_at in the same payload — see mig 231.",
  );
  process.exit(1);
}
console.log("activation-stamp-guard: all activation writers stamp activated_at ✓");

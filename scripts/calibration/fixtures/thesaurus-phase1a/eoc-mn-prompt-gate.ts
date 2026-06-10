/**
 * Thesaurus Phase 1a — P2 M1 fix: medical_necessity prompt-gate BYTE-IDENTITY fixture (no DB, no Haiku).
 *
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/eoc-mn-prompt-gate.ts   (run from repo root)
 *
 * The M1 fix gates the P2 content-type/split block behind `eoc_prose_prior_auth_v1`. This fixture proves,
 * BYTE-FOR-BYTE in BOTH directions, that the gate is correct and cannot drift:
 *   Direction 1 (flag OFF == post-D1): buildMedicalNecessityPrompt(vocab, false) is byte-identical to the
 *     frozen c21fa0b prompt (golden extracted from `git show c21fa0b`). This is the clean-rollback proof —
 *     no split → no coverage_rules clobber.
 *   Direction 2 (flag ON == current): buildMedicalNecessityPrompt(vocab, true) is byte-identical to the
 *     2a796e5 prompt (golden from `git show 2a796e5`) → the S182 design + the T5 eval stay valid.
 *   Plus: OFF carries NONE of the P2 markers; ON carries them; the default param fails toward today (OFF);
 *   vocab is spliced at the same point in both.
 *
 * Goldens are byte-exact slices (see /tmp gen scripts in the PR notes); regenerate only if the frozen
 * snapshot or the live prompt legitimately changes (then re-justify the change).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildMedicalNecessityPrompt } from "@/lib/eoc/haiku-prompts/medical-necessity";
import { INSTRUCTIONS_BODY_PRE_P2 } from "@/lib/eoc/haiku-prompts/medical-necessity-pre-p2";

const DIR = join(process.cwd(), "scripts/calibration/fixtures/thesaurus-phase1a");
const offGolden = readFileSync(join(DIR, "eoc-mn-prompt-pre-p2.golden.txt"), "utf8");
const onGolden = readFileSync(join(DIR, "eoc-mn-prompt-on.golden.txt"), "utf8");
const TAIL = "\n\n## NOW EXTRACT FROM THIS DOCUMENT SECTION:";
const VOCAB = "## CANONICAL SERVICE SLUG VOCABULARY\n- pcp_visit\n- specialist_visit";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}`);
  }
}
/** Byte-for-byte string equality with a first-divergence hint on failure. */
function eq(name: string, actual: string, expected: string): void {
  if (actual === expected) {
    pass++;
    console.log(`  PASS  ${name} (${Buffer.byteLength(actual)}B)`);
    return;
  }
  fail++;
  let i = 0;
  while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++;
  console.error(
    `  FAIL  ${name}\n        lengths ${actual.length} vs ${expected.length}; first diff @${i}: ` +
      `${JSON.stringify(actual.slice(i, i + 24))} vs ${JSON.stringify(expected.slice(i, i + 24))}`,
  );
}

const P2_MARKERS = [
  "CONTENT TYPE CLASSIFICATION",
  "one entry = one fact of one type",
  "type_confidence",
  "pa_polarity",
  "AXIS CARVE-OUT",
  "note the SPLIT",
];

console.log("P2 M1 — medical_necessity prompt-gate byte-identity fixture\n");

// ── Direction 1: flag OFF == post-D1 (c21fa0b), byte-for-byte ────────────────────────────────────
eq("OFF, empty vocab == c21fa0b golden", buildMedicalNecessityPrompt("", false), offGolden);
eq("OFF, no 2nd arg (default) == c21fa0b golden", buildMedicalNecessityPrompt(""), offGolden);
const offBody = offGolden.slice(0, offGolden.length - TAIL.length);
eq("OFF, with vocab == body + vocab + tail", buildMedicalNecessityPrompt(VOCAB, false), `${offBody}\n\n${VOCAB}${TAIL}`);
eq("OFF body == frozen INSTRUCTIONS_BODY_PRE_P2", offBody, INSTRUCTIONS_BODY_PRE_P2);

// ── Direction 2: flag ON == current (2a796e5), byte-for-byte ─────────────────────────────────────
eq("ON, empty vocab == 2a796e5 golden", buildMedicalNecessityPrompt("", true), onGolden);
const onBody = onGolden.slice(0, onGolden.length - TAIL.length);
eq("ON, with vocab == body + vocab + tail", buildMedicalNecessityPrompt(VOCAB, true), `${onBody}\n\n${VOCAB}${TAIL}`);

// ── Markers: the flag is a true master switch over the type/split divergence ─────────────────────
for (const m of P2_MARKERS) {
  check(`OFF prompt omits "${m}"`, !buildMedicalNecessityPrompt(VOCAB, false).includes(m));
  check(`ON  prompt carries "${m}"`, buildMedicalNecessityPrompt(VOCAB, true).includes(m));
}
check("OFF !== ON (the gate actually changes the prompt)", buildMedicalNecessityPrompt(VOCAB, false) !== buildMedicalNecessityPrompt(VOCAB, true));
check("OFF prompt is strictly shorter than ON (split block removed)", offGolden.length < onGolden.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

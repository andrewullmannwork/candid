/**
 * Thesaurus Phase 1a — P2 M1 fix: medical_necessity prompt-gate BYTE-IDENTITY fixture (no DB, no Haiku).
 *
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/eoc-mn-prompt-gate.ts   (run from repo root)
 *
 * CONTRACT (re-anchored S187 — cache_pad_v1; carve-out D7 in eoc_content_type_routing.md §6):
 *   OFF golden == HAIKU_CACHE_PAD + frozen INSTRUCTIONS_BODY_PRE_P2 + TAIL
 *   ON  golden == HAIKU_CACHE_PAD + live INSTRUCTIONS_BODY + TAIL
 * The flag toggles ONLY the P2 type/split block: both flag states carry the IDENTICAL pad prefix
 * (asserted below), OFF carries NONE of the P2 markers, ON carries them, the default param fails
 * toward today (OFF), and vocab is spliced at the same point in both. These goldens are also the
 * byte-pin of the production CACHE KEY — any drift silently busts prompt caching (~cost regression
 * with zero functional symptom), which is why they stay committed FILES compared with ===.
 *
 * GOLDEN LINEAGE / RETIREMENT NOTE: through S186 the goldens were byte-exact `git show` slices of
 * PROD commits c21fa0b (OFF/frozen) and 2a796e5 (ON/live). At S187 they were re-anchored by
 * regen-goldens.ts as PAD + <previous golden bytes> — the historical instruction bytes are carried
 * VERBATIM as the pad-stripped slice (the c21fa0b rollback guarantee holds at the instruction-byte
 * level; wire bytes additionally carry the always-on pad, both flag states — D7). Do NOT "restore"
 * goldens from `git show c21fa0b`/`2a796e5`; regenerate ONLY via regen-goldens.ts (same dir) after
 * a legitimate frozen-body / live-body / pad change, and re-justify the change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildMedicalNecessityPrompt } from "@/lib/eoc/haiku-prompts/medical-necessity";
import { INSTRUCTIONS_BODY_PRE_P2 } from "@/lib/eoc/haiku-prompts/medical-necessity-pre-p2";
import { HAIKU_CACHE_PAD } from "@/lib/haiku-client/cache-pad";

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

// ── Direction 1: flag OFF == padded post-D1 (pad + c21fa0b body), byte-for-byte ──────────────────
eq("OFF, empty vocab == padded pre-P2 golden (c21fa0b body)", buildMedicalNecessityPrompt("", false), offGolden);
eq("OFF, no 2nd arg (default) == padded pre-P2 golden", buildMedicalNecessityPrompt(""), offGolden);
const offHead = offGolden.slice(0, offGolden.length - TAIL.length); // PAD + frozen body
eq("OFF, with vocab == head + vocab + tail", buildMedicalNecessityPrompt(VOCAB, false), `${offHead}\n\n${VOCAB}${TAIL}`);
eq("OFF golden == PAD + frozen INSTRUCTIONS_BODY_PRE_P2 + TAIL (full composition)", offGolden, `${HAIKU_CACHE_PAD}${INSTRUCTIONS_BODY_PRE_P2}${TAIL}`);

// ── Direction 2: flag ON == padded current (pad + 2a796e5 body), byte-for-byte ───────────────────
eq("ON, empty vocab == padded ON golden (2a796e5 body)", buildMedicalNecessityPrompt("", true), onGolden);
const onHead = onGolden.slice(0, onGolden.length - TAIL.length); // PAD + live body
eq("ON, with vocab == head + vocab + tail", buildMedicalNecessityPrompt(VOCAB, true), `${onHead}\n\n${VOCAB}${TAIL}`);

// ── The pad (D7): identical in BOTH flag states; instruction-free; self-delimiting ───────────────
eq("OFF and ON goldens share an IDENTICAL pad prefix (the flag toggles ONLY the P2 block)",
  offGolden.slice(0, HAIKU_CACHE_PAD.length), onGolden.slice(0, HAIKU_CACHE_PAD.length));
check("ON golden starts with the pad", onGolden.startsWith(HAIKU_CACHE_PAD));
check("pad is self-delimiting (ends with blank line)", HAIKU_CACHE_PAD.endsWith("\n\n"));
check("pad is ASCII-only", /^[\x00-\x7F]*$/.test(HAIKU_CACHE_PAD));
check("pad omits the navigation cue token EXTRACT", !HAIKU_CACHE_PAD.includes("EXTRACT"));
for (const m of P2_MARKERS) {
  check(`pad omits P2 marker "${m}"`, !HAIKU_CACHE_PAD.includes(m));
}

// ── Markers: the flag is a true master switch over the type/split divergence ─────────────────────
for (const m of P2_MARKERS) {
  check(`OFF prompt omits "${m}"`, !buildMedicalNecessityPrompt(VOCAB, false).includes(m));
  check(`ON  prompt carries "${m}"`, buildMedicalNecessityPrompt(VOCAB, true).includes(m));
}
check("OFF !== ON (the gate actually changes the prompt)", buildMedicalNecessityPrompt(VOCAB, false) !== buildMedicalNecessityPrompt(VOCAB, true));
check("OFF prompt is strictly shorter than ON (split block removed; equal pad both sides)", offGolden.length < onGolden.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

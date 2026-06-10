/* eoc-mn-prompt-gate golden re-anchor (S187 — cache_pad_v1). COMMIT WITH THE GOLDENS.
 *
 * Derivation is FILE -> FILE: newGolden := HAIKU_CACHE_PAD bytes + old golden bytes. The old
 * goldens are byte-exact `body + TAIL` slices extracted from PROD commits c21fa0b (OFF/frozen)
 * and 2a796e5 (ON/live) — prepending the pad PRESERVES those historical instruction bytes
 * verbatim inside the new goldens (the c21fa0b rollback guarantee carries at the
 * instruction-byte level). buildMedicalNecessityPrompt is NEVER called here: a builder bug
 * (double pad, pad after vocab) must FAIL the fixture, not get baked into the goldens.
 *
 * Safety rails:
 *  - refuses to run without REGEN_GOLDENS=1
 *  - refuses to run if the old goldens do not satisfy the PRE-pad contract (OFF golden ===
 *    frozen INSTRUCTIONS_BODY_PRE_P2 + TAIL; both end with TAIL; OFF strictly shorter)
 *  - refuses to run twice (old goldens already pad-prefixed)
 *  - constants cross-check: new OFF golden must === `${PAD}${INSTRUCTIONS_BODY_PRE_P2}${TAIL}`
 *  - binary-safe writes (Buffer.concat; NO appended trailing newline — the goldens end ':')
 *  - cwd-immune (paths anchored to this file, not process.cwd())
 *
 *   REGEN_GOLDENS=1 npx tsx scripts/calibration/fixtures/thesaurus-phase1a/regen-goldens.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { INSTRUCTIONS_BODY_PRE_P2 } from "@/lib/eoc/haiku-prompts/medical-necessity-pre-p2";
import { HAIKU_CACHE_PAD, HAIKU_CACHE_PAD_VERSION } from "@/lib/haiku-client/cache-pad";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OFF_PATH = path.join(DIR, "eoc-mn-prompt-pre-p2.golden.txt");
const ON_PATH = path.join(DIR, "eoc-mn-prompt-on.golden.txt");
const TAIL = "\n\n## NOW EXTRACT FROM THIS DOCUMENT SECTION:";

function fail(msg: string): never {
  console.error(`REGEN ABORTED: ${msg}`);
  process.exit(1);
}

if (process.env.REGEN_GOLDENS !== "1") fail("set REGEN_GOLDENS=1 to confirm (this rewrites committed byte anchors)");

const offBytes = fs.readFileSync(OFF_PATH);
const onBytes = fs.readFileSync(ON_PATH);
const off = offBytes.toString("utf8");
const on = onBytes.toString("utf8");
const padBuf = Buffer.from(HAIKU_CACHE_PAD, "utf8");

// --- pre-pad contract assertions (TOCTOU rail: only re-anchor a tree where the old gate held)
if (off.startsWith("## CACHE PADDING")) fail("OFF golden is already pad-prefixed — re-anchor already done");
if (on.startsWith("## CACHE PADDING")) fail("ON golden is already pad-prefixed — re-anchor already done");
if (off !== `${INSTRUCTIONS_BODY_PRE_P2}${TAIL}`) fail("OFF golden !== frozen INSTRUCTIONS_BODY_PRE_P2 + TAIL (old contract broken — investigate before re-anchoring)");
if (!on.endsWith(TAIL)) fail("ON golden does not end with TAIL");
if (!(off.length < on.length)) fail("OFF golden is not strictly shorter than ON golden");
// pad content invariants the fixture will also assert
const P2_MARKERS = ["CONTENT TYPE CLASSIFICATION", "one entry = one fact of one type", "type_confidence", "pa_polarity", "AXIS CARVE-OUT", "note the SPLIT"];
for (const m of P2_MARKERS) if (HAIKU_CACHE_PAD.includes(m)) fail(`pad contains P2 marker "${m}"`);
if (HAIKU_CACHE_PAD.includes("EXTRACT")) fail("pad contains the navigation cue token EXTRACT");
if (!HAIKU_CACHE_PAD.endsWith("\n\n")) fail("pad is not self-delimiting (must end with \\n\\n)");
if (!/^[\x00-\x7F]*$/.test(HAIKU_CACHE_PAD)) fail("pad is not ASCII-only");

// --- file -> file derivation + constants cross-check
const newOff = Buffer.concat([padBuf, offBytes]);
const newOn = Buffer.concat([padBuf, onBytes]);
if (newOff.toString("utf8") !== `${HAIKU_CACHE_PAD}${INSTRUCTIONS_BODY_PRE_P2}${TAIL}`) {
  fail("constants cross-check failed: PAD + frozen body + TAIL !== PAD + old OFF bytes");
}

fs.writeFileSync(OFF_PATH, newOff);
fs.writeFileSync(ON_PATH, newOn);
console.log(`Re-anchored (${HAIKU_CACHE_PAD_VERSION}):`);
console.log(`  ${path.basename(OFF_PATH)}: ${offBytes.length} -> ${newOff.length} bytes`);
console.log(`  ${path.basename(ON_PATH)}: ${onBytes.length} -> ${newOn.length} bytes`);
console.log(`Now update the fixture's expected composition + run it: npx tsx scripts/calibration/fixtures/thesaurus-phase1a/eoc-mn-prompt-gate.ts`);

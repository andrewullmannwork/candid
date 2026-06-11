/**
 * Thesaurus Phase 1a — Step A trust-tiering logic fixture (no DB, no Haiku).
 *
 *   npx tsx scripts/calibration/fixtures/thesaurus-phase1a/trust-tiering.ts
 *
 * Proves the Step A invariants as PURE logic over the resolver's exported helpers:
 *   1. Allowlist (default-deny): seeds/corrections trusted; haiku_resolver + NULL +
 *      any unknown source quarantined.
 *   2. Config can EXTEND the trusted set but can NEVER un-quarantine haiku_resolver.
 *   3. Signature read filters BEFORE the per-signature dedup, so a quarantined
 *      high-confidence row cannot shadow a trusted lower-confidence row.
 *   4. Flag OFF → byte-identical (serve every row, first-by-confidence wins).
 *   5. Decision-1 safeguard: every known writer source is registered + classified.
 */
import {
  buildTrustedSourceSet,
  isTrustedSignatureSource,
  selectTrustedSignatureHits,
  ALL_KNOWN_CACHE_SOURCES,
  TRUSTED_SIGNATURE_SOURCES_DEFAULT,
  QUARANTINED_CACHE_SOURCES,
} from "@/lib/claims/service-resolver";

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

console.log("Step A — trust-tiering logic fixture\n");

// 1. Allowlist, default-deny.
const trusted = buildTrustedSourceSet();
check("thesaurus_remap is trusted", isTrustedSignatureSource("thesaurus_remap", trusted));
check("user_correction is trusted", isTrustedSignatureSource("user_correction", trusted));
check("haiku_resolver is quarantined", !isTrustedSignatureSource("haiku_resolver", trusted));
check("NULL source is quarantined (default-deny)", !isTrustedSignatureSource(null, trusted));
check(
  "unknown future source is quarantined (default-deny)",
  !isTrustedSignatureSource("some_future_writer", trusted),
);

// 2. Config extends, but cannot un-quarantine haiku_resolver.
const extended = buildTrustedSourceSet(["some_future_writer", "haiku_resolver"]);
check("config CAN extend the trusted set", isTrustedSignatureSource("some_future_writer", extended));
check(
  "config CANNOT un-quarantine haiku_resolver (hard-excluded)",
  !isTrustedSignatureSource("haiku_resolver", extended),
);

// 3 + 4. Filter-before-dedup (no shadowing) + flag-OFF byte-identical.
// Same signature 'phys-therapy': a quarantined haiku_resolver@0.95 ordered FIRST
// (as confidence-DESC would), then a trusted thesaurus_remap@0.95.
const rows = [
  { description_signature: "phys-therapy", service_slug: "wrong_slug", confidence: 0.95, source: "haiku_resolver" },
  { description_signature: "phys-therapy", service_slug: "pt_rehab", confidence: 0.95, source: "thesaurus_remap" },
  { description_signature: "hospice", service_slug: "hospice_outpatient", confidence: 0.95, source: "thesaurus_remap" },
  { description_signature: "lab-only-haiku", service_slug: "lab", confidence: 0.9, source: "haiku_resolver" },
];

const on = selectTrustedSignatureHits(rows, { trustEnabled: true, trustedSources: trusted });
check(
  "flag ON: quarantined row does NOT shadow trusted row (phys-therapy -> pt_rehab)",
  on.get("phys-therapy")?.slug === "pt_rehab",
);
check("flag ON: trusted seed served (hospice)", on.get("hospice")?.slug === "hospice_outpatient");
check("flag ON: haiku_resolver-only signature NOT served (lab-only-haiku)", !on.has("lab-only-haiku"));

const off = selectTrustedSignatureHits(rows, { trustEnabled: false, trustedSources: trusted });
check(
  "flag OFF: byte-identical — first row wins dedup (phys-therapy -> wrong_slug)",
  off.get("phys-therapy")?.slug === "wrong_slug",
);
check("flag OFF: haiku_resolver-only signature served (lab-only-haiku)", off.get("lab-only-haiku")?.slug === "lab");

// 5. Decision-1 classification safeguard.
for (const s of TRUSTED_SIGNATURE_SOURCES_DEFAULT) {
  check(`registry classifies '${s}' as trusted_signature`, ALL_KNOWN_CACHE_SOURCES[s] === "trusted_signature");
}
for (const s of QUARANTINED_CACHE_SOURCES) {
  check(`registry classifies '${s}' as quarantined`, ALL_KNOWN_CACHE_SOURCES[s] === "quarantined");
}
check("registry includes code_observation (code_cache)", ALL_KNOWN_CACHE_SOURCES["code_observation"] === "code_cache");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

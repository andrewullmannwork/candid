/**
 * Ing-E Phase 3 — backfill reconstruction fixture (no PROD; Ship Gate G4).
 *
 * Proves redactColumnValue rebuilds EACH surface kind correctly: redacts every text
 * unit in place, preserves structure / cardinality / order / non-text keys, leaves
 * clean input byte-identical (same reference → a no-op backfill writes nothing), and
 * that the per-unit coverage-preservation + idempotency asserts hold. Synthetic inputs
 * only, reusing the redactor fixture's proven strings.
 *
 * Run: npx tsx scripts/calibration/pii/pii-backfill-fixture.ts
 */
import { redactText } from "@/lib/parser/pii-redactor";
import { hasCoverageTokens } from "@/lib/parser/pii-patterns";
import { redactColumnValue, type RedactFn, type UnitRedaction } from "@/lib/parser/pii-surface-iter";
import { type CanonicalSurface } from "@/lib/parser/pii-surfaces";

let pass = 0;
const fails: string[] = [];
const check = (label: string, cond: boolean): void => {
  if (cond) pass++;
  else fails.push(label);
};

const redact: RedactFn = (t) => {
  const r = redactText(t);
  return { redacted: r.redacted, changed: r.changed, patterns: [...new Set(r.redactions.map((x) => x.patternName))] };
};
const coverageLost = (u: UnitRedaction[]): boolean => u.some((x) => hasCoverageTokens(x.before) && !hasCoverageTokens(x.after));
const nonIdempotent = (u: UnitRedaction[]): boolean => u.some((x) => redactText(x.after).changed);

const PII = "Member ID: W123456789 — $30 copay"; // auto-PII (member id) + coverage token
const CLEAN = "Primary care visit: $30 copay"; // no auto-PII

const S = (kind: CanonicalSurface["kind"], arrayField?: string): CanonicalSurface => ({
  id: `test.${kind}`, table: "t", column: "c", kind, arrayField, tier: 1,
  visibility: "canonical_cross_user", sweep: true, notes: "",
});

// ── text_column (canonical_haiku_extractions.source_excerpt) ──
{
  const r = redactColumnValue(S("text_column"), PII, redact);
  const out = r.newValue as string;
  check("text_column: changed", r.changed);
  check("text_column: PII removed", !out.includes("W123456789"));
  check("text_column: coverage preserved", out.includes("$30 copay"));
  check("text_column: marker present", out.includes("[REDACTED:"));
  check("text_column: exactly 1 unit", r.units.length === 1);
  check("text_column: no coverage-loss", !coverageLost(r.units));
  check("text_column: idempotent", !nonIdempotent(r.units));
  const c = redactColumnValue(S("text_column"), CLEAN, redact);
  check("text_column: clean unchanged (same ref)", !c.changed && c.newValue === CLEAN);
}

// ── text_array (description_examples / provider_descriptions) ──
{
  const arr = [CLEAN, PII, "SSN 123-45-6789"];
  const r = redactColumnValue(S("text_array"), arr, redact);
  const out = r.newValue as string[];
  check("text_array: changed", r.changed);
  check("text_array: length preserved", out.length === 3);
  check("text_array: clean element untouched (same ref)", out[0] === CLEAN);
  check("text_array: PII element redacted + coverage kept", !out[1].includes("W123456789") && out[1].includes("$30 copay"));
  check("text_array: ssn element redacted", out[2].includes("[REDACTED:") && !out[2].includes("123-45-6789"));
  check("text_array: 2 changed units", r.units.length === 2);
  check("text_array: no coverage-loss", !coverageLost(r.units));
  check("text_array: idempotent", !nonIdempotent(r.units));
  const cleanArr = [CLEAN, "Inpatient: 20% coinsurance after deductible"];
  const c = redactColumnValue(S("text_array"), cleanArr, redact);
  check("text_array: all-clean unchanged (same ref)", !c.changed && c.newValue === cleanArr);
}

// ── jsonb_array_field (corroborator_sources.raw_description) ──
{
  const arr = [
    { raw_description: PII, user_id: "u1", weight: 3 },
    { raw_description: CLEAN, user_id: "u2", weight: 1 },
  ];
  const r = redactColumnValue(S("jsonb_array_field", "raw_description"), arr, redact);
  const out = r.newValue as Array<Record<string, unknown>>;
  check("jsonb_array_field: changed", r.changed);
  check("jsonb_array_field: length preserved", out.length === 2);
  check("jsonb_array_field: raw_description redacted", String(out[0].raw_description).includes("[REDACTED:") && !String(out[0].raw_description).includes("W123456789"));
  check("jsonb_array_field: coverage preserved", String(out[0].raw_description).includes("$30 copay"));
  check("jsonb_array_field: non-text keys preserved", out[0].user_id === "u1" && out[0].weight === 3);
  check("jsonb_array_field: clean element untouched (same ref)", out[1] === arr[1]);
}

// ── jsonb_provenance_sources_excerpt (field_provenance) ──
{
  const fp = {
    deductible_individual: {
      sources: [
        { excerpt: PII, document_ref: "11111111-1111-1111-1111-111111111111", weight: 2 },
        { excerpt: CLEAN, document_ref: "22222222-2222-2222-2222-222222222222" },
      ],
    },
    copay: { sources: [{ excerpt: CLEAN }] },
  };
  const r = redactColumnValue(S("jsonb_provenance_sources_excerpt"), fp, redact);
  const out = r.newValue as Record<string, { sources: Array<Record<string, unknown>> }>;
  const src = out.deductible_individual.sources;
  check("provenance: changed", r.changed);
  check("provenance: excerpt redacted", String(src[0].excerpt).includes("[REDACTED:") && !String(src[0].excerpt).includes("W123456789"));
  check("provenance: document_ref preserved", src[0].document_ref === "11111111-1111-1111-1111-111111111111");
  check("provenance: sibling weight preserved", src[0].weight === 2);
  check("provenance: coverage preserved", String(src[0].excerpt).includes("$30 copay"));
  check("provenance: clean source untouched (same ref)", src[1].excerpt === CLEAN);
  check("provenance: unit carries field name", r.units.some((u) => u.field === "deductible_individual"));
  check("provenance: clean field untouched", out.copay.sources[0].excerpt === CLEAN);
}

// ── null / empty are no-ops ──
{
  const n = redactColumnValue(S("text_column"), null, redact);
  check("null column: no-op", !n.changed && n.newValue === null);
}

const total = pass + fails.length;
console.log(`\nPII backfill reconstruction fixture: ${pass}/${total} PASS`);
if (fails.length) {
  console.log(`${fails.length} FAILURE(S):`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all kinds rebuild correctly; coverage + structure + references preserved.\n");

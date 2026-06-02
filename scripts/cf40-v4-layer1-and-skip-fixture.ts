/**
 * Ing-D.0b fixture — CF-40 v4 Layer 1 contribution gate + smart-skip orchestrator.
 *
 * Two PURE suites (no DB; deterministic; manually runnable):
 *   A. evaluateValidityGates — the contribution gate. Confirms each gate fires on
 *      a below-threshold MEASURED value AND is INAPPLICABLE (skipped) on a null
 *      signal (the Ing-D.0b "enforce-when-present" semantic for self-check / OCR /
 *      classification), plus the always-on structural gates (validity window,
 *      file size, auth, banned, re-baseline).
 *   B. evaluateSmartSkipEligibility — the orchestrator. Covers all 5 decisionLayer
 *      outcomes (layer1 / layer2 / layer3 / layer5 / all_pass).
 *
 * Run:  npx tsx scripts/cf40-v4-layer1-and-skip-fixture.ts
 *
 * Ship Gate G4 (block_ship_gate.md). CI wiring is the follow-up obligation; mirrors
 * the standalone-fixture pattern (Ing-D.0a, Ing-K, Ing-B, soft-hyphen). The IO
 * gather (evaluateV4SmartSkip / recorder writes) is exercised in the dry-run + smoke.
 */

import {
  evaluateValidityGates,
  evaluateSmartSkipEligibility,
  type ForcedReparseInput,
  type ValidityGateInput,
} from "@/lib/parser/cf40-v4";

const NOW = new Date("2026-06-02T00:00:00.000Z");
const DAY_MS = 86_400_000;

// ── Suite A — Layer 1 contribution gate ──────────────────────────────────────

// Baseline: every gate PASSES. Doc-quality signals present + above threshold,
// current plan year, ample file size, phone+email verified, not banned, not
// re-baseline. Individual cases mutate one field to assert one gate.
const L1_BASE: ValidityGateInput = {
  selfCheckPassRate: 0.99,
  ocrConfidence: 0.95,
  classificationConfidence: 0.97,
  uploadedAt: NOW,
  documentPlanYear: 2026,
  fileSizeBytes: 200_000,
  docType: "sbc",
  uploaderTier: "phone_email_verified",
  isAdmin: false,
  isBanned: false,
  canonicalReBaselineRequired: false,
};

interface L1Case {
  name: string;
  input: ValidityGateInput;
  expectPass: boolean;
  expectReason?: string; // a failure reason that MUST be present when expectPass=false
}

const L1_CASES: L1Case[] = [
  { name: "A1. all gates pass", input: L1_BASE, expectPass: true },
  // Doc-quality gates: fire on a measured below-threshold value …
  { name: "A2. self-check 0.5 < 0.95 → fail", input: { ...L1_BASE, selfCheckPassRate: 0.5 }, expectPass: false, expectReason: "self_check_pass_rate_below_threshold" },
  { name: "A3. OCR 0.5 < 0.85 → fail", input: { ...L1_BASE, ocrConfidence: 0.5 }, expectPass: false, expectReason: "ocr_confidence_below_threshold" },
  { name: "A4. classification 0.5 < 0.90 → fail", input: { ...L1_BASE, classificationConfidence: 0.5 }, expectPass: false, expectReason: "classification_confidence_below_threshold" },
  // … and are INAPPLICABLE (skipped) on a null signal (enforce-when-present).
  { name: "A5. self-check NULL → inapplicable → pass", input: { ...L1_BASE, selfCheckPassRate: null }, expectPass: true },
  { name: "A6. OCR NULL → inapplicable → pass", input: { ...L1_BASE, ocrConfidence: null }, expectPass: true },
  { name: "A7. classification NULL (e.g. admin upload) → inapplicable → pass", input: { ...L1_BASE, classificationConfidence: null }, expectPass: true },
  { name: "A8. all three doc-quality NULL → pass on structural gates alone", input: { ...L1_BASE, selfCheckPassRate: null, ocrConfidence: null, classificationConfidence: null }, expectPass: true },
  // Always-on structural gates.
  { name: "A9. file size below SBC min (20KB) → fail", input: { ...L1_BASE, fileSizeBytes: 5_000 }, expectPass: false, expectReason: "file_size_below_minimum" },
  { name: "A10. unverified + non-admin → fail auth", input: { ...L1_BASE, uploaderTier: "unverified" }, expectPass: false, expectReason: "uploader_unauthenticated" },
  { name: "A11. banned uploader → fail", input: { ...L1_BASE, isBanned: true }, expectPass: false, expectReason: "uploader_banned" },
  { name: "A12. canonical re_baseline_required → fail", input: { ...L1_BASE, canonicalReBaselineRequired: true }, expectPass: false, expectReason: "canonical_re_baseline_required" },
  { name: "A13. stale plan year (2019 uploaded 2026) → outside validity window", input: { ...L1_BASE, documentPlanYear: 2019 }, expectPass: false, expectReason: "outside_validity_window" },
  { name: "A14. admin upload, doc-quality NULL, no classification → pass (admin auth)", input: { ...L1_BASE, isAdmin: true, uploaderTier: "admin", selfCheckPassRate: null, ocrConfidence: null, classificationConfidence: null }, expectPass: true },
];

// ── Suite B — smart-skip orchestrator (5 decisionLayer outcomes) ──────────────

// A forced-reparse input that does NOT force (so all_pass is reachable).
const NO_FORCE: ForcedReparseInput = {
  isAdmin: false,
  scaleTier: "small",
  smartSkipCount: 1, // not a multiple of 5 → no every-5th
  lastFullParseAt: new Date(NOW.getTime() - 5 * DAY_MS).toISOString(), // recent
  divergencePendingVerification: false,
  adminAttestedNeedsValidation: false,
  randomFn: () => 1, // never < sampleRate → no statistical sample
  now: NOW,
};

// Skip-time validity input: doc-quality inherited via Layer 2 → null. Passes.
const SKIP_VALID: ValidityGateInput = {
  selfCheckPassRate: null,
  ocrConfidence: null,
  classificationConfidence: null,
  uploadedAt: NOW,
  documentPlanYear: 2026,
  fileSizeBytes: 200_000,
  docType: "sbc",
  uploaderTier: "phone_email_verified",
  isAdmin: false,
  isBanned: false,
  canonicalReBaselineRequired: false,
};

interface SkipCase {
  name: string;
  input: {
    validityInput: ValidityGateInput;
    layer2Stable: boolean;
    doctypePromoted: boolean;
    forcedReparseInput: ForcedReparseInput;
  };
  expectEligible: boolean;
  expectLayer: "layer1" | "layer2" | "layer3" | "layer5" | "all_pass";
}

const SKIP_CASES: SkipCase[] = [
  {
    name: "B1. all_pass → ELIGIBLE (skip)",
    input: { validityInput: SKIP_VALID, layer2Stable: true, doctypePromoted: true, forcedReparseInput: NO_FORCE },
    expectEligible: true,
    expectLayer: "all_pass",
  },
  {
    name: "B2. layer1 (re_baseline_required) → not eligible",
    input: { validityInput: { ...SKIP_VALID, canonicalReBaselineRequired: true }, layer2Stable: true, doctypePromoted: true, forcedReparseInput: NO_FORCE },
    expectEligible: false,
    expectLayer: "layer1",
  },
  {
    name: "B3. layer2 (weight < 3.0) → not eligible",
    input: { validityInput: SKIP_VALID, layer2Stable: false, doctypePromoted: true, forcedReparseInput: NO_FORCE },
    expectEligible: false,
    expectLayer: "layer2",
  },
  {
    name: "B4. layer3 (doc-type not promoted) → not eligible",
    input: { validityInput: SKIP_VALID, layer2Stable: true, doctypePromoted: false, forcedReparseInput: NO_FORCE },
    expectEligible: false,
    expectLayer: "layer3",
  },
  {
    name: "B5. layer5 (every-5th smart-skip forces full parse) → not eligible",
    input: { validityInput: SKIP_VALID, layer2Stable: true, doctypePromoted: true, forcedReparseInput: { ...NO_FORCE, smartSkipCount: 5 } },
    expectEligible: false,
    expectLayer: "layer5",
  },
  {
    name: "B6. layer5 (admin-attestation needs organic validation) → not eligible",
    input: { validityInput: SKIP_VALID, layer2Stable: true, doctypePromoted: true, forcedReparseInput: { ...NO_FORCE, adminAttestedNeedsValidation: true } },
    expectEligible: false,
    expectLayer: "layer5",
  },
];

// ── Run ───────────────────────────────────────────────────────────────────────

let failures = 0;

console.log("CF-40 v4 Ing-D.0b — Layer 1 contribution gate + smart-skip orchestrator fixture\n");
console.log("Suite A — Layer 1 validity gates (contribution gate)");
for (const c of L1_CASES) {
  const r = evaluateValidityGates(c.input);
  const passOk = r.pass === c.expectPass;
  const reasonOk = c.expectPass || !c.expectReason || r.failureReasons.includes(c.expectReason as never);
  const ok = passOk && reasonOk;
  if (!ok) failures += 1;
  const detail = r.pass ? "pass" : `fail=[${r.failureReasons.join(", ")}]`;
  console.log(`${ok ? "✓ PASS" : "✗ FAIL"}  ${c.name}\n         ${detail}`);
}

console.log("\nSuite B — smart-skip orchestrator");
for (const c of SKIP_CASES) {
  const r = evaluateSmartSkipEligibility(c.input);
  const ok = r.eligible === c.expectEligible && r.decisionLayer === c.expectLayer;
  if (!ok) failures += 1;
  console.log(`${ok ? "✓ PASS" : "✗ FAIL"}  ${c.name}\n         eligible=${r.eligible} layer=${r.decisionLayer} reason=${r.failureReason ?? "—"}`);
}

const total = L1_CASES.length + SKIP_CASES.length;
console.log(`\n${total - failures}/${total} passed.`);
if (failures > 0) {
  console.error(`\n${failures} case(s) FAILED.`);
  process.exit(1);
}
console.log("All cases passed.");

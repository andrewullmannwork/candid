/**
 * S138 PR2 calibration runner — code_identity site.
 *
 * Mirrors src/lib/parser/code-identity.ts haikuNearestSignature prompt.
 *
 * 5 synthetic test cases spanning CPT/HCPCS/NDC/REV/DRG. Each case has:
 *   - target: raw description + normalized signature
 *   - candidates: existing signatures (synthetic) to match against
 *   - expected match: known-correct best signature
 *
 * For each unit × {temp=1.0, temp=0}, calls Haiku once + writes artifact.
 *
 * Vault layout: site_subdir = `code-identity/<unit>/input.json` (records the
 * target+candidates+expected match) + `haiku-defect-floor.json` + `haiku-temp-0.json`.
 *
 * Output normalized to harness shape:
 *   { parsed: { bestMatchSignature: { value, source_excerpt? }, similarity: { value, source_excerpt? } } }
 */

import { resolve } from 'path';
import { getClient, runBothTemperatures, VAULT_BASE, writeArtifact, type RunResult } from './_shared';

const SITE_SUBDIR = 'code-identity';

const HAIKU_NEAREST_INSTRUCTIONS = `You are matching a medical billing line item description to the closest existing description signature for the same billing code.

Input JSON:
{
  "target": { "raw": "<raw provider description>", "signature": "<normalized target signature>" },
  "candidates": [ { "signature": "<existing>", "examples": ["<raw>", ...] }, ... ]
}

Return ONE JSON object with this shape (no markdown, no commentary):
{
  "best_match_signature": "<existing signature>" | null,
  "similarity": 0.0..1.0,
  "reason": "<one sentence>"
}

Scoring guide:
- similarity >= 0.85 → "same semantic concept; reuse the existing mapping"
- similarity <  0.85 → "different concept; propose a new signature"

HIGH similarity examples (>=0.85):
- "OFFICE VISIT PREV EST AGE 18-39" ↔ "office visit preventive established"
- "Pfizer SARS-CoV-2 mRNA Vaccine" ↔ "COVID-19 vaccine mRNA"
- "MRI BRAIN W/O CONTRAST" ↔ "magnetic resonance imaging brain"

LOW similarity examples (<0.85):
- "office visit preventive" ↔ "office visit problem focused"
- "flu vaccine" ↔ "COVID vaccine"
- "lab panel comprehensive" ↔ "lab panel basic"

If candidates is empty or none match semantically, return best_match_signature=null with similarity=0.`;

interface TestCase {
  unit: string;
  target: { raw: string; signature: string };
  candidates: Array<{ signature: string; examples: string[] }>;
  expected_match: string | null;
  notes: string;
}

const TEST_CASES: TestCase[] = [
  {
    unit: 'cpt-99213',
    target: {
      raw: 'OFFICE VISIT PROBLEM EST AGE 18-39',
      signature: '18 39 age est office problem visit',
    },
    candidates: [
      {
        signature: 'established office problem visit',
        examples: ['Office visit, problem focused, established patient'],
      },
      {
        signature: 'established office preventive visit',
        examples: ['Office visit, preventive, established'],
      },
    ],
    expected_match: 'established office problem visit',
    notes: 'CPT 99213 — established patient problem visit; should match problem-focused candidate, NOT preventive',
  },
  {
    unit: 'hcpcs-J0129',
    target: {
      raw: 'ABATACEPT INJECTION 10 MG',
      signature: '10 abatacept injection mg',
    },
    candidates: [
      {
        signature: 'abatacept injection',
        examples: ['Abatacept inj', 'abatacept injection 10mg'],
      },
      {
        signature: 'adalimumab injection',
        examples: ['Humira injection'],
      },
    ],
    expected_match: 'abatacept injection',
    notes: 'HCPCS J0129 — abatacept; should match abatacept candidate, NOT adalimumab (different biologic)',
  },
  {
    unit: 'ndc-00310-7461-30',
    target: {
      raw: 'CRESTOR 20MG TAB',
      signature: '20mg crestor tab',
    },
    candidates: [
      {
        signature: 'crestor rosuvastatin tablet',
        examples: ['Crestor 10mg tablet', 'rosuvastatin 20mg'],
      },
      {
        signature: 'lipitor atorvastatin tablet',
        examples: ['Lipitor 20mg'],
      },
    ],
    expected_match: 'crestor rosuvastatin tablet',
    notes: 'NDC for Crestor — should match the Crestor candidate, NOT Lipitor (different statin)',
  },
  {
    unit: 'rev-0250',
    target: {
      raw: 'PHARMACY GENERAL CLASSIFICATION',
      signature: 'classification general pharmacy',
    },
    candidates: [
      {
        signature: 'general pharmacy revenue',
        examples: ['Pharmacy', 'pharmacy general'],
      },
      {
        signature: 'pharmacy compounded prescription',
        examples: ['Compounded RX'],
      },
    ],
    expected_match: 'general pharmacy revenue',
    notes: 'REV 0250 — general pharmacy classification; should match general candidate, NOT compounded',
  },
  {
    unit: 'drg-470',
    target: {
      raw: 'MAJOR JOINT REPLACEMENT OR REATTACHMENT OF LOWER EXTREMITY W/O MCC',
      signature: 'extremity joint lower major mcc reattachment replacement w o',
    },
    candidates: [
      {
        signature: 'major joint replacement lower extremity',
        examples: ['Major joint or limb reattachment lower extremity'],
      },
      {
        signature: 'spinal fusion cervical',
        examples: ['Cervical spine fusion'],
      },
    ],
    expected_match: 'major joint replacement lower extremity',
    notes: 'DRG 470 — major joint replacement; should match joint replacement candidate, NOT spinal fusion',
  },
];

function normalize(raw: Record<string, unknown> | null, expected: string | null): Record<string, unknown> {
  if (!raw) return {};
  const best = raw.best_match_signature ?? null;
  const sim = raw.similarity ?? null;
  // Use the canonical field names declared in types.ts (camelCase).
  // For harness scoring: produce {value, source_excerpt} per field; source_excerpt is the raw reason text so excerpt-verification is non-trivial (left empty → harness marks unverifiable, no penalty).
  return {
    bestMatchSignature: {
      value: best,
      source_excerpt: typeof raw.reason === 'string' ? String(raw.reason).slice(0, 200) : '',
    },
    similarity: {
      value: sim,
      source_excerpt: '',
    },
    // Diagnostic-only: not in canonical_fields; goes to drift bucket
    _expected_match: expected,
    _reason: raw.reason ?? null,
  };
}

async function main() {
  console.log('=== S138 PR2 calibration: code_identity site ===\n');
  const client = getClient();
  let totalCost = 0;

  for (const tc of TEST_CASES) {
    console.log(`── Unit: ${tc.unit} ──`);
    const unitDir = resolve(VAULT_BASE, SITE_SUBDIR, tc.unit);

    // Persist input + expected for reproducibility
    writeArtifact(resolve(unitDir, 'input.json'), {
      parsed: {
        input: JSON.stringify({ target: tc.target, candidates: tc.candidates }),
        expected_match: tc.expected_match,
        notes: tc.notes,
      } as Record<string, unknown>,
      raw: '',
      usage: { input_tokens: 0, output_tokens: 0 },
      elapsed_ms: 0,
      cost_usd: 0,
      parse_error: null,
    } as RunResult);

    const userContent = JSON.stringify(
      { target: tc.target, candidates: tc.candidates },
      null,
      2,
    );

    const { defectFloor, temp0 } = await runBothTemperatures({
      systemPrompt: HAIKU_NEAREST_INSTRUCTIONS,
      userContent,
      sectionLabel: tc.unit,
      maxTokens: 512,
      client,
      defectFloorPath: resolve(unitDir, 'haiku-defect-floor.json'),
      temp0Path: resolve(unitDir, 'haiku-temp-0.json'),
    });

    // Re-write artifacts with normalized parsed shape
    writeArtifact(resolve(unitDir, 'haiku-defect-floor.json'), {
      ...defectFloor,
      parsed: normalize(defectFloor.parsed, tc.expected_match),
    });
    writeArtifact(resolve(unitDir, 'haiku-temp-0.json'), {
      ...temp0,
      parsed: normalize(temp0.parsed, tc.expected_match),
    });

    totalCost += defectFloor.cost_usd + temp0.cost_usd;
    console.log('');
  }

  console.log(`Total spend: $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

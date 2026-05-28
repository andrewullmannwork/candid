/**
 * S138 PR2 calibration runner — description_match site.
 *
 * Mirrors src/lib/claims/service-mapper.ts prompt. service-mapper batches all
 * line items into ONE Haiku call returning an array; we follow that pattern so
 * the calibration cost characteristics match PROD.
 *
 * 5 representative bill line item descriptions × {temp=1.0, temp=0}. Per state,
 * ONE Haiku call returns 5 per-line {serviceSlug, confidence} entries. We
 * decompose into per-unit artifacts in the vault.
 *
 * Vault layout: site_subdir = `description-match/<unit>/input.json` + per-temp
 * artifacts.
 */

import { resolve } from 'path';
import { getClient, runHaikuOnce, VAULT_BASE, writeArtifact, type RunResult } from './_shared';

const SITE_SUBDIR = 'description-match';

const SERVICE_SLUGS = [
  'pcp_visit', 'specialist_visit', 'telehealth_pcp', 'telehealth_specialist',
  'convenience_care_clinic', 'second_opinion',
  'preventive_care', 'annual_physical', 'immunizations', 'cancer_screening',
  'well_child_visit', 'womens_sterilization',
  'er_visit', 'emergency_transport_ground', 'emergency_transport_air', 'urgent_care',
  'inpatient_facility', 'inpatient_physician',
  'outpatient_surgery_facility', 'outpatient_surgery_physician',
  'diagnostic_test', 'advanced_imaging', 'radiology_basic',
  'lab_pcp_office', 'lab_specialist_office', 'lab_outpatient_facility', 'lab_independent',
  'generic_rx_tier1', 'preferred_brand_rx_tier2', 'non_preferred_rx_tier3', 'specialty_rx_tier4',
  'preventive_rx', 'chemotherapy_rx',
  'pt_rehab', 'ot_rehab', 'speech_therapy', 'pulmonary_rehab', 'cognitive_therapy',
  'cardiac_rehab', 'chiropractic', 'acupuncture', 'habilitation',
  'mental_health_outpatient', 'mental_health_inpatient', 'mental_health_telehealth',
  'mental_health_partial', 'substance_abuse_outpatient', 'substance_abuse_inpatient',
  'prenatal_visit', 'delivery_facility', 'delivery_professional',
  'durable_medical_equipment', 'prosthetics', 'diabetic_equipment',
  'home_health', 'skilled_nursing', 'hospice_inpatient', 'hospice_outpatient',
  'bereavement_counseling', 'dialysis', 'transplant', 'nutritional_counseling',
  'genetic_counseling', 'allergy_treatment', 'medical_pharmaceuticals', 'gene_therapy',
  'abortion', 'bariatric_surgery', 'childrens_eye_exam', 'childrens_glasses',
  'childrens_dental', 'dental_injury',
];

interface LineItem {
  unit: string;
  lineNumber: number;
  description: string;
  billingCode: string;
  billingCodeType: string;
  expected_slug: string;
}

const LINE_ITEMS: LineItem[] = [
  {
    unit: 'desc-office-visit',
    lineNumber: 1,
    description: 'OFFICE VISIT EST PT MOD 25',
    billingCode: '99213',
    billingCodeType: 'CPT',
    expected_slug: 'pcp_visit',
  },
  {
    unit: 'desc-lab-cbc',
    lineNumber: 2,
    description: 'BLOOD COUNT COMPLETE CBC W/AUTO DIFF',
    billingCode: '85025',
    billingCodeType: 'CPT',
    expected_slug: 'lab_independent',
  },
  {
    unit: 'desc-radiology-mri',
    lineNumber: 3,
    description: 'MRI BRAIN W/O CONTRAST',
    billingCode: '70551',
    billingCodeType: 'CPT',
    expected_slug: 'advanced_imaging',
  },
  {
    unit: 'desc-emergency-room',
    lineNumber: 4,
    description: 'EMERGENCY DEPT VISIT LEVEL 4',
    billingCode: '99284',
    billingCodeType: 'CPT',
    expected_slug: 'er_visit',
  },
  {
    unit: 'desc-physical-therapy',
    lineNumber: 5,
    description: 'PT EVAL MODERATE COMPLEXITY',
    billingCode: '97162',
    billingCodeType: 'CPT',
    expected_slug: 'pt_rehab',
  },
];

const PROMPT_PREFIX = `Map each bill line item to the BEST matching service slug from this list:

${SERVICE_SLUGS.join(', ')}

Line items from a medical bill:
`;

const PROMPT_SUFFIX = `

Rules:
- Use the description text and billing code to determine the service type
- Pick the single best slug — do not invent new slugs
- If a line item truly doesn't match anything (e.g., administrative fees), use "other" as the slug with low confidence
- confidence is 0.0-1.0: high (0.8+) for clear matches, medium (0.5-0.7) for reasonable guesses, low (<0.5) for uncertain

Return JSON array, one object per line item:
[{"lineNumber": 1, "serviceSlug": "specialist_visit", "confidence": 0.9}, ...]`;

interface RawLine {
  lineNumber?: number;
  serviceSlug?: string;
  confidence?: number;
}

function writePerUnitArtifacts(
  result: RunResult,
  variant: 'haiku-defect-floor.json' | 'haiku-temp-0.json',
): void {
  const items: RawLine[] = Array.isArray(result.parsed?.items)
    ? (result.parsed!.items as RawLine[])
    : Array.isArray(result.parsed)
      ? (result.parsed as RawLine[])
      : [];

  for (const li of LINE_ITEMS) {
    const match = items.find((r) => r.lineNumber === li.lineNumber);
    const unitDir = resolve(VAULT_BASE, SITE_SUBDIR, li.unit);
    const perUnit: RunResult = {
      parsed: {
        serviceSlug: { value: match?.serviceSlug ?? null, source_excerpt: '' },
        confidence: { value: match?.confidence ?? null, source_excerpt: '' },
        _expected_slug: li.expected_slug,
      } as Record<string, unknown>,
      raw: result.raw,
      usage: result.usage,
      elapsed_ms: result.elapsed_ms,
      cost_usd: result.cost_usd / LINE_ITEMS.length, // amortize batch cost across units
      parse_error: result.parse_error,
    };
    writeArtifact(resolve(unitDir, variant), perUnit);
  }
}

function writePerUnitInputs(): void {
  for (const li of LINE_ITEMS) {
    const unitDir = resolve(VAULT_BASE, SITE_SUBDIR, li.unit);
    writeArtifact(resolve(unitDir, 'input.json'), {
      parsed: {
        description: li.description,
        billingCode: li.billingCode,
        billingCodeType: li.billingCodeType,
        expected_slug: li.expected_slug,
      } as Record<string, unknown>,
      raw: '',
      usage: { input_tokens: 0, output_tokens: 0 },
      elapsed_ms: 0,
      cost_usd: 0,
      parse_error: null,
    } as RunResult);
  }
}

async function main() {
  console.log('=== S138 PR2 calibration: description_match site ===\n');
  const client = getClient();

  writePerUnitInputs();

  const itemList = LINE_ITEMS
    .map((li) => `Line ${li.lineNumber}: "${li.description}" Code: ${li.billingCode} (${li.billingCodeType})`)
    .join('\n');
  const userContent = itemList + PROMPT_SUFFIX;

  console.log('Batch call: 5 line items, single Haiku invocation');
  console.log('');
  console.log('  DEFECT floor (temp=1.0)...');
  const defectFloor = await runHaikuOnce({
    systemPrompt: PROMPT_PREFIX,
    userContent,
    sectionLabel: 'description_match',
    temperature: 1.0,
    maxTokens: 2048,
    client,
  });
  console.log(`    ${defectFloor.parse_error ?? 'parsed'} · $${defectFloor.cost_usd.toFixed(4)} · ${defectFloor.elapsed_ms}ms`);
  writePerUnitArtifacts(defectFloor, 'haiku-defect-floor.json');

  console.log('  temp=0 baseline...');
  const temp0 = await runHaikuOnce({
    systemPrompt: PROMPT_PREFIX,
    userContent,
    sectionLabel: 'description_match',
    temperature: 0,
    maxTokens: 2048,
    client,
  });
  console.log(`    ${temp0.parse_error ?? 'parsed'} · $${temp0.cost_usd.toFixed(4)} · ${temp0.elapsed_ms}ms`);
  writePerUnitArtifacts(temp0, 'haiku-temp-0.json');

  console.log(`\nTotal spend: $${(defectFloor.cost_usd + temp0.cost_usd).toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

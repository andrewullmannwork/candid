/**
 * S138 PR2 calibration runner — eoc site (eligibility_rules section).
 *
 * Mirrors src/lib/eoc/haiku-prompts/eligibility-rules.ts INSTRUCTIONS against
 * the ECM EOC OCR. Critically, the runner reproduces PROD's section-shape input:
 * `src/lib/eoc/parser.ts` calls `dispatchSection` → `sliceSection(workingText, range)`
 * which passes ONLY the eligibility_rules section text (~50-80K chars), not the
 * full 767K-char OCR. Sending full OCR was found (S138 methodology audit) to
 * push Haiku past its JSON-output reliability zone at temp=0; PROD never sees
 * that input shape.
 *
 * This runner mirrors PROD: regex-match the eligibility section heading anchor
 * (skipping past the TOC region) + slice from there to the next priority-section
 * heading, then send just that slice to extractEligibilityRules's prompt.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getClient, runHaikuOnce, VAULT_BASE, writeArtifact, type RunResult } from './_shared';

const PROMPT_PATH = '/Users/andrewullmann/Desktop/candid/src/lib/eoc/haiku-prompts/eligibility-rules.ts';
const PREFIX = 'eoc-';
const DOC = 'ecm-eoc';

// Mirror src/lib/eoc/section-segment.ts SECTION_PATTERNS for eligibility_rules
// + the priority sections we'd stop at (whichever comes next anchors the end).
const ELIGIBILITY_PATTERN = /^\s*(ELIGIBILITY (?:RULES?|REQUIREMENTS|AND ENROLLMENT)|WHO IS ELIGIBLE|ENROLLMENT (?:RULES?|REQUIREMENTS|PROCEDURES)|EFFECTIVE DATE|COBRA (?:CONTINUATION|COVERAGE)|SPECIAL ENROLLMENT|QUALIFYING (?:LIFE )?EVENTS?|Premiums, Eligibility, and Enrollment)\b/im;
const NEXT_SECTION_PATTERN = /^\s*(PRIOR AUTHORIZATION|MEDICAL NECESSITY|APPEALS? (?:PROCEDURES?|PROCESS|RIGHTS)|HOW TO (?:FILE AN |APPEAL)|INTERNAL (?:AND EXTERNAL )?(?:REVIEW|APPEAL)|EXTERNAL REVIEW|GRIEVANCE|COMPLAINTS? AND APPEALS?|COORDINATION OF BENEFITS|COB (?:RULES?|PROVISIONS?)|DEFINITIONS|GLOSSARY OF TERMS|KEY TERMS|TERMS YOU SHOULD KNOW|YOUR RIGHTS|NONDISCRIMINATION NOTICE|TERMINATION OF MEMBERSHIP)\b/im;

function extractPromptInstructions(): string {
  const src = readFileSync(PROMPT_PATH, 'utf-8');
  const m = src.match(/const INSTRUCTIONS = `([\s\S]*?)`;/);
  if (!m) throw new Error(`Could not extract INSTRUCTIONS from ${PROMPT_PATH}`);
  return m[1];
}

function findEligibilitySection(ocr: string): { start: number; end: number; text: string } {
  // Skip the TOC region (first ~2000 lines often have heading echoes) by starting
  // the search past line ~2000. ECM EOC has "...29" TOC entries early.
  const tocLikelyEnd = 60000; // rough char offset past TOC
  const tail = ocr.slice(tocLikelyEnd);
  const elMatch = tail.match(ELIGIBILITY_PATTERN);
  if (!elMatch || elMatch.index === undefined) {
    throw new Error('Could not find eligibility section heading via regex');
  }
  const sectionStart = tocLikelyEnd + elMatch.index;

  // Find the next priority section heading AFTER section start
  const afterStart = ocr.slice(sectionStart + 100); // skip past the heading itself
  const nextMatch = afterStart.match(NEXT_SECTION_PATTERN);
  // If no next heading, take up to 80K chars (typical max section size)
  const sectionEnd = nextMatch && nextMatch.index !== undefined
    ? sectionStart + 100 + nextMatch.index
    : Math.min(ocr.length, sectionStart + 80_000);

  return {
    start: sectionStart,
    end: sectionEnd,
    text: ocr.slice(sectionStart, sectionEnd),
  };
}

function normalize(raw: Record<string, unknown> | null): Record<string, unknown> {
  if (!raw) return {};
  const shared = typeof raw.source_excerpt === 'string' ? raw.source_excerpt : '';
  return {
    effectiveDateRule: {
      value: typeof raw.effective_date_rule === 'string' && raw.effective_date_rule.length > 0
        ? raw.effective_date_rule
        : null,
      source_excerpt: shared,
    },
    dependentAgeLimit: {
      value: typeof raw.dependent_age_limit === 'number' ? raw.dependent_age_limit : null,
      source_excerpt: shared,
    },
    cobraEligible: {
      value: typeof raw.cobra_eligible === 'boolean' ? raw.cobra_eligible : null,
      source_excerpt: shared,
    },
    cobraMaxMonths: {
      value: typeof raw.cobra_max_months === 'number' ? raw.cobra_max_months : null,
      source_excerpt: shared,
    },
    specialEnrollmentEvents: {
      value: Array.isArray(raw.special_enrollment_events) && raw.special_enrollment_events.length > 0
        ? raw.special_enrollment_events.join(',')
        : null,
      source_excerpt: shared,
    },
  };
}

async function main() {
  console.log('=== S138 PR2 calibration: eoc site (PROD-shape input) ===\n');
  const client = getClient();
  const instructions = extractPromptInstructions();
  console.log(`Prompt: ${instructions.length} chars from ${PROMPT_PATH}`);

  const ocrPath = resolve(VAULT_BASE, DOC, 'ocr.txt');
  const ocr = readFileSync(ocrPath, 'utf-8');
  console.log(`Full OCR: ${ocr.length} chars`);

  const section = findEligibilitySection(ocr);
  console.log(`Section: offset ${section.start}-${section.end} = ${section.text.length} chars`);
  console.log(`First 200 chars of section text:`);
  console.log(`  "${section.text.slice(0, 200).replace(/\n/g, ' ')}"`);
  console.log('');

  console.log('  DEFECT floor (temp=1.0)...');
  const defectFloor = await runHaikuOnce({
    systemPrompt: instructions,
    userContent: section.text,
    sectionLabel: `eoc/${DOC} (section-shape)`,
    temperature: 1.0,
    maxTokens: 4096,
    client,
  });
  const dfPath = resolve(VAULT_BASE, DOC, `${PREFIX}haiku-defect-floor.json`);
  writeArtifact(dfPath, {
    ...defectFloor,
    parsed: normalize(defectFloor.parsed),
  } as RunResult);
  console.log(`    ${defectFloor.parse_error ?? 'parsed'} · $${defectFloor.cost_usd.toFixed(4)} · ${defectFloor.elapsed_ms}ms`);

  console.log('  temp=0 baseline...');
  const temp0 = await runHaikuOnce({
    systemPrompt: instructions,
    userContent: section.text,
    sectionLabel: `eoc/${DOC} (section-shape)`,
    temperature: 0,
    maxTokens: 4096,
    client,
  });
  const t0Path = resolve(VAULT_BASE, DOC, `${PREFIX}haiku-temp-0.json`);
  writeArtifact(t0Path, {
    ...temp0,
    parsed: normalize(temp0.parsed),
  } as RunResult);
  console.log(`    ${temp0.parse_error ?? 'parsed'} · $${temp0.cost_usd.toFixed(4)} · ${temp0.elapsed_ms}ms`);

  console.log(`\nTotal spend: $${(defectFloor.cost_usd + temp0.cost_usd).toFixed(4)}`);

  // Summary verdict
  if (defectFloor.parse_error === null && temp0.parse_error === null) {
    console.log('\n✓ VERDICT: temp=0 NO regression on PROD-shape input. Prior failure was runner-methodology artifact.');
  } else if (temp0.parse_error !== null) {
    console.log('\n✗ VERDICT: temp=0 STILL fails on PROD-shape input. Real PR1 regression confirmed.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

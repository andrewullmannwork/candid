/**
 * composition-copy — S326 eleven-rules Rule 1: the composition step's finding
 * cards, ONE fixture-scannable home (copy + the pure card builder).
 *
 * v4 (Andrew-approved mock): the audit's findings ARE the selection surface —
 * each card is a checkable FACT, service-first, in BILL ORDER. The legal
 * architecture the copy holds (models doc §I.3 Rule 1, verified holdings):
 *   - a sentence's subject is a DOCUMENT'S CONTENT ("the same code appears
 *     twice"), never the member's legal position or what they should do;
 *   - helper lines are CONDITIONALS ABOUT THE DOCUMENT tied to something the
 *     member can know ("If you received this service once that day, not
 *     twice, this could be an error." — Andrew's wording pattern, S326), and
 *     exist ONLY where such a member-knowable conditional is honest;
 *   - the fact→ground mapping is DISCLOSED on the card ("Raised in the letter
 *     as …" — the published static table, surfaced at the moment it matters);
 *   - cards sort by bill line, NEVER by dollars or severity (fixture-pinned).
 * The fact-copy guard scans THIS file's rendered strings against the
 * banned-verdict vocabulary — add copy here, never inline in components.
 */

// Client-safe re-export: the litigation-hold copy + step id live in
// letter-access (pure, no server imports) — ONE home, both surfaces.
export { LITIGATION_HOLD_MESSAGE, LITIGATION_STEP_ID as LITIGATION_STEP_ID_UI } from '@/lib/disputes/letter-access';

import {
  deriveFindingToGround,
  groundMemberParty,
  DISPUTE_GROUND_CATALOG,
} from '@/lib/disputes/dispute-ground-catalog';
import type { DisputeGroundType } from '@/lib/disputes/dispute-grounds';

const FINDING_TO_GROUND = deriveFindingToGround();

const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** One raw dispute entry as the claim page already holds it (the shared
 *  collectDisputeEntries output — no new fetch, no new derivation). */
export interface CompositionEntryInput {
  /** The audit finding's id (stable within this page load; grouping key). */
  findingId: string;
  findingType: string;
  /** Bill line number; null for claim-level findings. */
  lineNumber: number | null;
  serviceName: string | null;
  code: string | null;
  billedAmount: number | null;
  benchmarkAmount: number | null;
  serviceDate: string | null;
}

/** A rendered, checkable finding card (grouped; bill order). */
export interface FindingCard {
  /** Selection key — the grouped finding's id. */
  key: string;
  findingType: string;
  ground: DisputeGroundType;
  groundLabel: string;
  /** Which letter the ground is raised in. */
  party: 'insurer' | 'provider' | 'both';
  /** Service-first headline: "Office/outpatient visit (99213) — the same code…" */
  serviceName: string;
  code: string | null;
  factSentence: string;
  mathLine: string | null;
  /** Andrew's conditional pattern; null where no member-knowable conditional is honest. */
  helperLine: string | null;
  /** Bill line numbers this card draws on (empty = claim-level). */
  lineNumbers: number[];
}

interface CardCopy {
  fact: (i: { count: number }) => string;
  math: (i: { billed: number | null; benchmark: number | null; date: string | null; count: number }) => string | null;
  helper: ((i: { count: number }) => string) | null;
}

/**
 * Per-finding-type card copy. Subject = the document, every time. Types absent
 * here (or mapped to no ground) render no card — a member-composed letter can
 * only argue what the published table maps.
 */
export const FINDING_CARD_COPY: Record<string, CardCopy> = {
  duplicate: {
    fact: () => 'the same code appears twice on the same date of service',
    math: ({ billed, date }) =>
      billed != null ? `${money(billed)} billed each time${date ? ` · ${date}` : ''}` : null,
    helper: () => 'If you received this service once that day, not twice, this could be an error.',
  },
  overcharge: {
    fact: () => 'billed above the public reference rate',
    math: ({ billed, benchmark }) =>
      billed != null && benchmark != null
        ? `${money(billed)} billed · Medicare national average ${money(benchmark)}`
        : billed != null
          ? `${money(billed)} billed`
          : null,
    helper: null,
  },
  balance_billing: {
    fact: () => 'billed above the plan-allowed amount shown in your records',
    math: ({ billed }) => (billed != null ? `${money(billed)} billed` : null),
    helper: null,
  },
  unbundling: {
    fact: () => 'codes that belong to one bundled procedure appear as separate charges',
    math: ({ billed }) => (billed != null ? `${money(billed)} billed across the pieces` : null),
    helper: () => 'If this was one procedure, not several, this could be an error.',
  },
  missing_adjustment: {
    fact: () => 'an adjustment on your EOB does not appear on this bill',
    math: ({ billed }) => (billed != null ? `${money(billed)} billed` : null),
    helper: null,
  },
  insurance_underpayment: {
    fact: () => 'your EOB and this bill state different insurer payment amounts',
    math: ({ billed }) => (billed != null ? `${money(billed)} billed` : null),
    helper: null,
  },
  zero_cost_share_overcharge: {
    fact: () => 'your plan documents list a $0 share for this service; the bill shows a charge to you',
    math: ({ billed }) => (billed != null ? `${money(billed)} billed` : null),
    helper: null,
  },
  unallocated_balance: {
    fact: () => "the bill's line amounts and reductions do not add up to its stated total",
    math: () => null,
    helper: null,
  },
  chargemaster: {
    fact: () => "billed above this provider's own published price for this code",
    math: ({ billed, benchmark }) =>
      billed != null && benchmark != null
        ? `${money(billed)} billed · published price ${money(benchmark)}`
        : billed != null
          ? `${money(billed)} billed`
          : null,
    helper: null,
  },
};

/**
 * Group the page's dispute entries into checkable cards: one card per audit
 * finding (a multi-line finding — the duplicate pair — is ONE decision),
 * sorted by first bill line (BILL ORDER — never dollars, never severity;
 * fixture-pinned), claim-level cards last. Cards whose ground belongs to the
 * OTHER recipient's letter are returned separately for the route strip.
 */
export function buildFindingCards(
  entries: CompositionEntryInput[],
  recipient: 'insurer' | 'provider' | 'collector',
): { cards: FindingCard[]; otherTrack: FindingCard[] } {
  const groups = new Map<string, CompositionEntryInput[]>();
  for (const e of entries) {
    const key = e.findingId || `${e.findingType}:${e.lineNumber ?? 'claim'}`;
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }
  const cards: FindingCard[] = [];
  const otherTrack: FindingCard[] = [];
  for (const [key, group] of groups) {
    const first = group[0];
    const copy = FINDING_CARD_COPY[first.findingType];
    const ground = (FINDING_TO_GROUND as Record<string, DisputeGroundType | undefined>)[
      first.findingType
    ];
    if (!copy || !ground) continue; // unmapped facts cannot be argued — no card
    const lineNumbers = Array.from(
      new Set(group.map((g) => g.lineNumber).filter((n): n is number => n != null)),
    ).sort((a, b) => a - b);
    const count = Math.max(group.length, lineNumbers.length || 1);
    const party = groundMemberParty(ground);
    const card: FindingCard = {
      key,
      findingType: first.findingType,
      ground,
      groundLabel: DISPUTE_GROUND_CATALOG[ground].memberLabel,
      party,
      serviceName: first.serviceName || 'Billed service',
      code: first.code,
      factSentence: copy.fact({ count }),
      mathLine: copy.math({
        billed: first.billedAmount,
        benchmark: first.benchmarkAmount,
        date: first.serviceDate,
        count,
      }),
      helperLine: copy.helper ? copy.helper({ count }) : null,
      lineNumbers,
    };
    const matches =
      party === 'both' || (recipient === 'insurer' ? party === 'insurer' : party === 'provider');
    (matches ? cards : otherTrack).push(card);
  }
  const byBillOrder = (a: FindingCard, b: FindingCard) => {
    const an = a.lineNumbers[0] ?? Number.MAX_SAFE_INTEGER; // claim-level last
    const bn = b.lineNumbers[0] ?? Number.MAX_SAFE_INTEGER;
    return an - bn;
  };
  cards.sort(byBillOrder);
  otherTrack.sort(byBillOrder);
  return { cards, otherTrack };
}

/** "bill line 3" / "bill lines 1 & 2" — the provenance chip (letters cite
 *  line numbers, so the reference survives; empty for claim-level). */
export function lineRefLabel(lineNumbers: number[]): string | null {
  if (lineNumbers.length === 0) return null;
  if (lineNumbers.length === 1) return `bill line ${lineNumbers[0]}`;
  return `bill lines ${lineNumbers.slice(0, -1).join(', ')} & ${lineNumbers[lineNumbers.length - 1]}`;
}

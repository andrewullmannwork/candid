'use client';

/**
 * CompositionStep — S326 eleven-rules Rules 1+2 (member_composition_v1),
 * v4 (Andrew-approved mock, plans/mocks/s326-composition-step-mock-v4.html).
 *
 * FACTS FIRST: the audit's findings are the selection surface — checkable
 * fact cards, service-first, in BILL ORDER (never dollars/severity), nothing
 * pre-checked, no select-all. Each card states the fact, the arithmetic, the
 * (optional) member-knowable conditional in Andrew's wording pattern, and the
 * DISCLOSED static mapping ("Raised in the letter as …"). The full ground
 * catalog stays one tap away ("Something else wrong…") — it carries the
 * undetectable grounds (a service never received) and the other-track routes,
 * satisfying the full-list requirement. Citations are a No/Yes question with
 * "No" the plain-words default (the memo's CLEANER shape — the only direction
 * the design may lean). The lawsuit question (Rule 8) is required once per
 * claim and persists through the EXISTING checklist write.
 *
 * The server independently enforces the selection (fail-closed) — this UI is
 * choreography, never the gate. Light theme only, matching the app.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ModalShell } from '@/components/modal';
import { cn } from '@/lib/utils/cn';
import {
  DISPUTE_GROUND_CATALOG,
  ALL_DISPUTE_GROUND_TYPES,
  LETTER_CITATION_MENU,
  groundMemberParty,
} from '@/lib/disputes/dispute-ground-catalog';
import type { DisputeGroundType } from '@/lib/disputes/dispute-grounds';
import { CITATION_REGISTRY } from '@/lib/disputes/citation-registry';
import { letterRecipientKind } from '@/lib/disputes/letter-type';
import {
  LITIGATION_HOLD_MESSAGE,
  LITIGATION_STEP_ID_UI,
  buildFindingCards,
  lineRefLabel,
  type CompositionEntryInput,
  type FindingCard,
} from './composition-copy';

export type { CompositionEntryInput };

export interface MemberCompositionSelection {
  grounds: DisputeGroundType[];
  adoptedCitations: string[];
  /** The finding-grain record (the member's concrete checks) — richer
   *  *Reynoso* evidence than category checks; persisted + event payloads. */
  selectedFacts: Array<{ groundType: DisputeGroundType; findingType: string; lines: number[] }>;
}

interface CompositionStepProps {
  open: boolean;
  onClose: () => void;
  letterType: string;
  claimId: string;
  entries: CompositionEntryInput[];
  litigationPreAnswer: 'yes' | 'no' | null;
  getAuthToken: () => Promise<string | null>;
  submitting?: boolean;
  onCompose: (selection: MemberCompositionSelection) => void;
}

export function CompositionStep({
  open,
  onClose,
  letterType,
  claimId,
  entries,
  litigationPreAnswer,
  getAuthToken,
  submitting = false,
  onCompose,
}: CompositionStepProps) {
  const [checkedCards, setCheckedCards] = useState<Set<string>>(new Set());
  const [checkedGrounds, setCheckedGrounds] = useState<Set<DisputeGroundType>>(new Set());
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [citeAnswer, setCiteAnswer] = useState<'no' | 'yes'>('no');
  const [adopted, setAdopted] = useState<Set<string>>(new Set());
  const [expandedGround, setExpandedGround] = useState<DisputeGroundType | null>(null);
  const [litigation, setLitigation] = useState<'yes' | 'no' | null>(litigationPreAnswer);
  const [savingAnswer, setSavingAnswer] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recipient = letterRecipientKind(letterType as Parameters<typeof letterRecipientKind>[0]);
  const citationMenu =
    (LETTER_CITATION_MENU as Record<string, readonly string[]>)[letterType] ?? [];
  const { cards, otherTrack } = useMemo(
    () => buildFindingCards(entries, recipient),
    [entries, recipient],
  );

  const selectedCards = cards.filter((c) => checkedCards.has(c.key));
  const selectionCount = selectedCards.length + checkedGrounds.size;

  function toggleCard(key: string) {
    setCheckedCards((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleGround(g: DisputeGroundType) {
    setCheckedGrounds((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }
  function toggleCitation(key: string) {
    setAdopted((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleCompose() {
    setError(null);
    if (litigation == null) {
      setError('Please answer the lawsuit question first.');
      return;
    }
    if (litigation !== litigationPreAnswer) {
      setSavingAnswer(true);
      try {
        const token = await getAuthToken();
        if (!token) throw new Error('Sign-in expired. Please reload and try again.');
        const res = await fetch(`/api/claims/${claimId}/checklist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ stepId: LITIGATION_STEP_ID_UI, checked: true, note: litigation }),
        });
        if (!res.ok) throw new Error('Could not save your answer. Please try again.');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save your answer.');
        setSavingAnswer(false);
        return;
      }
      setSavingAnswer(false);
    }
    if (litigation === 'yes') return;
    if (selectionCount === 0) {
      setError('Check at least one item — the letter argues only what you select.');
      return;
    }
    const grounds = Array.from(
      new Set<DisputeGroundType>([...selectedCards.map((c) => c.ground), ...checkedGrounds]),
    );
    onCompose({
      grounds,
      adoptedCitations: citeAnswer === 'yes' ? Array.from(adopted) : [],
      selectedFacts: selectedCards.map((c) => ({
        groundType: c.ground,
        findingType: c.findingType,
        lines: c.lineNumbers,
      })),
    });
  }

  const litigationHold = litigation === 'yes';
  const busy = submitting || savingAnswer;

  const cardNode = (c: FindingCard) => {
    const isChecked = checkedCards.has(c.key);
    const ref = lineRefLabel(c.lineNumbers);
    return (
      <label
        key={c.key}
        className={cn(
          'flex cursor-pointer items-start gap-3 rounded-2xl border px-3.5 py-3 transition-colors',
          isChecked
            ? 'border-blue-500 bg-gradient-to-b from-blue-50 to-white shadow-[0_0_0_3px_rgba(37,99,235,0.07)]'
            : 'border-gray-200 bg-white hover:border-gray-300',
        )}
      >
        <input
          type="checkbox"
          className="mt-0.5 h-[18px] w-[18px] rounded-md border-gray-300 text-blue-600"
          checked={isChecked}
          disabled={busy}
          onChange={() => toggleCard(c.key)}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold leading-snug text-gray-900">
            {c.serviceName}
            {c.code && (
              <span className="ml-1.5 rounded-md bg-gray-100 px-1.5 py-px text-[11px] font-medium text-gray-600">
                {c.code}
              </span>
            )}
            <span className="font-semibold"> — {c.factSentence}</span>
            {ref && (
              <span className="ml-1.5 whitespace-nowrap rounded-full border border-gray-200 bg-white px-2 py-px text-[10.5px] font-normal text-gray-500">
                {ref}
              </span>
            )}
          </span>
          {c.mathLine && (
            <span className="mt-0.5 block text-[12.5px] tabular-nums text-gray-700">{c.mathLine}</span>
          )}
          {c.helperLine && (
            <span className="mt-1 block text-[12px] text-gray-500">{c.helperLine}</span>
          )}
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-gray-500">
            Raised in the letter as
            <span
              className={cn(
                'rounded-full px-2 py-px font-semibold',
                isChecked ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600',
              )}
            >
              {c.groundLabel}
            </span>
          </span>
        </span>
      </label>
    );
  };

  return (
    <ModalShell open={open} onClose={busy ? () => {} : onClose} title="Compose your letter">
      <div className="space-y-4 text-sm">
        <p className="-mt-1 text-[12.5px] text-gray-500">
          Here’s what our check of your documents shows. You choose what the letter disputes — it
          argues only what you check.
        </p>

        {/* 1 — the findings, bill order */}
        <section>
          <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-gray-500">
            What our check found — check what you want to dispute
          </h3>
          {cards.length === 0 ? (
            <p className="rounded-xl bg-gray-50 px-3 py-2.5 text-[13px] text-gray-500">
              Our check didn’t flag anything on this bill for this letter. You can still raise a
              ground yourself below.
            </p>
          ) : (
            <div className="space-y-2">{cards.map(cardNode)}</div>
          )}
          {otherTrack.length > 0 && (
            <p className="mt-2 flex items-center gap-2 rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3.5 py-2.5 text-[12.5px] text-gray-500">
              <span>
                <b className="text-gray-700">
                  {otherTrack.length} finding{otherTrack.length === 1 ? '' : 's'}
                </b>{' '}
                belong{otherTrack.length === 1 ? 's' : ''} in the{' '}
                <b className="text-gray-700">{recipient === 'insurer' ? 'provider' : 'insurer'} letter</b>{' '}
                — compose {otherTrack.length === 1 ? 'it' : 'them'} from that track.
              </span>
            </p>
          )}
        </section>

        {/* 2 — the full catalog, always reachable */}
        <section>
          <button
            type="button"
            onClick={() => setCatalogOpen((v) => !v)}
            className="flex w-full items-center gap-2 rounded-xl border border-dashed border-gray-300 bg-gray-50 px-3.5 py-2.5 text-left text-[12.5px] text-gray-600 hover:bg-gray-100"
          >
            <span aria-hidden>➕</span>
            <span>
              <b className="text-gray-800">Something else wrong with this bill?</b> See all dispute
              grounds — including ones no tool can detect, like a service you never received.
            </span>
            <span className="ml-auto whitespace-nowrap text-[12px] font-semibold text-blue-600">
              {catalogOpen ? 'Hide ▴' : 'All grounds ▸'}
            </span>
          </button>
          {catalogOpen && (
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {ALL_DISPUTE_GROUND_TYPES.map((g) => {
                const spec = DISPUTE_GROUND_CATALOG[g];
                const party = groundMemberParty(g);
                const matches =
                  party === 'both' ||
                  (recipient === 'insurer' ? party === 'insurer' : party === 'provider');
                const isChecked = checkedGrounds.has(g);
                return (
                  <div
                    key={g}
                    className={cn(
                      'flex items-start gap-2.5 rounded-xl border px-3 py-2.5',
                      isChecked
                        ? 'border-blue-500 bg-gradient-to-b from-blue-50 to-white'
                        : 'border-gray-200 bg-white',
                    )}
                  >
                    {matches ? (
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600"
                        checked={isChecked}
                        disabled={busy}
                        onChange={() => toggleGround(g)}
                      />
                    ) : (
                      <span className="mt-0.5 whitespace-nowrap rounded-md bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        {party === 'insurer' ? 'Insurer letter' : 'Provider letter'}
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold leading-tight text-gray-900">
                        {spec.memberLabel}
                      </span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-gray-500">
                        {spec.memberDescription}
                      </span>
                      <button
                        type="button"
                        className="mt-0.5 text-[11px] font-semibold text-blue-600 hover:underline"
                        onClick={(e) => {
                          e.preventDefault();
                          setExpandedGround((prev) => (prev === g ? null : g));
                        }}
                      >
                        {expandedGround === g ? 'Hide what counts as this' : 'What counts as this?'}
                      </button>
                      {expandedGround === g && (
                        <span className="mt-1 block rounded-lg bg-gray-50 px-2.5 py-1.5 text-[11.5px] text-gray-600">
                          {spec.mappingPlainLanguage}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 3 — the live selection contract */}
        {selectionCount > 0 && !litigationHold && (
          <section className="rounded-2xl border border-blue-500 bg-gradient-to-b from-blue-50 to-white px-3.5 py-2.5">
            <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-blue-700">
              Your letter will dispute
            </h3>
            {selectedCards.map((c) => (
              <p key={c.key} className="py-0.5 text-[12.5px] text-gray-700">
                <span className="font-semibold text-gray-900">{c.groundLabel}</span>
                {' — '}
                {c.serviceName}
                {c.code ? ` (${c.code})` : ''}
                {c.mathLine ? ` · ${c.mathLine}` : ''}
                {lineRefLabel(c.lineNumbers) ? ` · ${lineRefLabel(c.lineNumbers)}` : ''}
              </p>
            ))}
            {Array.from(checkedGrounds).map((g) => (
              <p key={g} className="py-0.5 text-[12.5px] text-gray-700">
                <span className="font-semibold text-gray-900">
                  {DISPUTE_GROUND_CATALOG[g].memberLabel}
                </span>
                {' — '}your own assertion (no parsed line maps to this ground)
              </p>
            ))}
          </section>
        )}

        {/* 4 — citations + the lawsuit question */}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {citationMenu.length > 0 ? (
            <section className="rounded-xl border border-gray-200 px-3.5 py-2.5">
              <div className="flex items-baseline justify-between">
                <h3 className="text-[12.5px] font-semibold text-gray-900">Cite the law in my letter?</h3>
              </div>
              <p className="mt-0.5 text-[11.5px] text-gray-500">
                “No” keeps every request in plain words — same asks, no statutes.
              </p>
              <div className="mt-2 flex gap-2">
                {(['no', 'yes'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    disabled={busy}
                    onClick={() => setCiteAnswer(v)}
                    className={cn(
                      'rounded-full border-[1.5px] px-4 py-1 text-[12.5px] font-semibold',
                      citeAnswer === v
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-gray-200 text-gray-600',
                    )}
                  >
                    {v === 'no' ? 'No' : 'Yes'}
                  </button>
                ))}
              </div>
              {citeAnswer === 'yes' && (
                <div className="mt-2 space-y-1.5">
                  {citationMenu.map((key) => {
                    const entry = CITATION_REGISTRY[key];
                    if (!entry) return null;
                    return (
                      <label
                        key={key}
                        className="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 px-2.5 py-1.5"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600"
                          checked={adopted.has(key)}
                          disabled={busy}
                          onChange={() => toggleCitation(key)}
                        />
                        <span>
                          <span className="block text-[12px] font-semibold text-gray-900">{entry.cite}</span>
                          <span className="block text-[11.5px] text-gray-500">{entry.label}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </section>
          ) : (
            <section className="rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5">
              <h3 className="text-[12.5px] font-semibold text-gray-700">Cite the law in my letter?</h3>
              <p className="mt-0.5 text-[11.5px] text-gray-500">
                Provider letters cite nothing by design — the facts and the asks carry the letter.
              </p>
            </section>
          )}

          <section className="rounded-xl border border-gray-200 px-3.5 py-2.5">
            <div className="flex items-baseline justify-between">
              <h3 className="text-[12.5px] font-semibold text-gray-900">Any lawsuit over this bill?</h3>
              <span className="text-[10.5px] text-gray-400">required once</span>
            </div>
            <p className="mt-0.5 text-[11.5px] text-gray-500">
              If yes, letters aren’t the right tool — we’ll point you to legal aid.
            </p>
            <div className="mt-2 flex gap-2">
              {(['no', 'yes'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={busy || litigationPreAnswer === 'yes'}
                  onClick={() => setLitigation(v)}
                  className={cn(
                    'rounded-full border-[1.5px] px-4 py-1 text-[12.5px] font-semibold',
                    litigation === v
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 text-gray-600',
                  )}
                >
                  {v === 'no' ? 'No' : 'Yes'}
                </button>
              ))}
            </div>
          </section>
        </div>

        {litigationHold && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-900">
            {LITIGATION_HOLD_MESSAGE}{' '}
            <Link href="/learn/medical-bill-in-collections" className="font-semibold underline">
              Read the self-help guide
            </Link>{' '}
            — it includes how to find free or low-cost legal aid.
          </div>
        )}

        {error && <p className="text-[13px] text-red-600">{error}</p>}

        <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-3">
          <p className="min-w-[200px] flex-1 text-[11px] text-gray-400">
            This product is not a substitute for the advice of an attorney.
          </p>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl px-4 py-2 text-[13px] font-medium text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
          {!litigationHold && (
            <button
              type="button"
              onClick={handleCompose}
              disabled={busy}
              className="rounded-xl bg-blue-600 px-4 py-2 text-[13px] font-bold text-white shadow-[0_0_20px_rgba(37,99,235,0.18)] hover:bg-blue-700 disabled:opacity-60"
            >
              {busy
                ? 'Working…'
                : `Create my letter${selectionCount > 0 ? ` · ${selectionCount} item${selectionCount === 1 ? '' : 's'} selected` : ''}`}
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

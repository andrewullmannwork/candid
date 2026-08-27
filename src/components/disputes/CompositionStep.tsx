'use client';

/**
 * CompositionStep — S326 eleven-rules Rule 1+2 (member_composition_v1).
 *
 * The pre-generate composition step: the MEMBER, not the engine, selects which
 * dispute grounds the letter argues. Renders, in order:
 *
 *   1. THE FACTS — what the documents show, neutral voice, per line. Dollars
 *      render as document arithmetic (billed amounts, reference rates); no
 *      verdicts, no severities, no strength grades, and NEVER a dollar
 *      attached to a checkbox (a "recover $X" badge is detection steering —
 *      the banned class).
 *   2. THE CATALOG — every ground from DISPUTE_GROUND_CATALOG in its fixed
 *      order, identical for every member every time: plain-language label +
 *      description + the published "what counts as this" mapping. Checkboxes;
 *      NOTHING pre-checked, no counts, no highlighting, no "likely", no
 *      reordering. Checking a ground reveals the member's own facts the static
 *      table maps under it; a checked ground with no mapped facts shows the
 *      honest empty. Grounds asked of the OTHER recipient stay visible but
 *      uncheckable here, with the pointer to that track.
 *   3. CITATIONS (insurer letters) — the static LETTER_CITATION_MENU entries
 *      with the registry's own plain-English labels; optional; none pre-checked.
 *   4. THE LITIGATION QUESTION (Rule 8) — required once per claim; yes = the
 *      hold panel (no letters; self-help + find-a-lawyer resources). Persisted
 *      via the EXISTING claim checklist write (stepId screening:litigation).
 *
 * Built on ModalShell (the DisputePlanChooser pre-generate-step precedent).
 * Presentational + one checklist POST; the caller composes via the generate
 * route, which independently enforces the same selection server-side
 * (fail-closed — this UI is convenience, never the gate).
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ModalShell } from '@/components/modal';
import { cn } from '@/lib/utils/cn';
import {
  DISPUTE_GROUND_CATALOG,
  ALL_DISPUTE_GROUND_TYPES,
  LETTER_CITATION_MENU,
  deriveFindingToGround,
  groundMemberParty,
} from '@/lib/disputes/dispute-ground-catalog';
import type { DisputeGroundType } from '@/lib/disputes/dispute-grounds';
import { CITATION_REGISTRY } from '@/lib/disputes/citation-registry';
import { letterRecipientKind } from '@/lib/disputes/letter-type';
import {
  LITIGATION_HOLD_MESSAGE,
  LITIGATION_STEP_ID_UI,
  COMPOSITION_FACT_TEMPLATES,
  factStatement,
  type CompositionFact,
} from './composition-copy';

export type { CompositionFact };
export { COMPOSITION_FACT_TEMPLATES };

export interface MemberCompositionSelection {
  grounds: DisputeGroundType[];
  adoptedCitations: string[];
}

const FINDING_TO_GROUND = deriveFindingToGround();

interface CompositionStepProps {
  open: boolean;
  onClose: () => void;
  /** The letter this composition feeds (drives recipient labeling + the citation menu). */
  letterType: string;
  claimId: string;
  /** Neutral facts, built by the caller from the claim rows it already holds. */
  facts: CompositionFact[];
  /** Prior screening answer from claims.metadata.guideSteps, when loaded. */
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
  facts,
  litigationPreAnswer,
  getAuthToken,
  submitting = false,
  onCompose,
}: CompositionStepProps) {
  const [checked, setChecked] = useState<Set<DisputeGroundType>>(new Set());
  const [adopted, setAdopted] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<DisputeGroundType>>(new Set());
  const [litigation, setLitigation] = useState<'yes' | 'no' | null>(litigationPreAnswer);
  const [savingAnswer, setSavingAnswer] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recipient = letterRecipientKind(letterType as Parameters<typeof letterRecipientKind>[0]);
  const citationMenu =
    (LETTER_CITATION_MENU as Record<string, readonly string[]>)[letterType] ?? [];

  // The member's facts grouped by the STATIC mapping (finding type → ground).
  // Identical logic for every member — the published table's client half.
  const factsByGround = useMemo(() => {
    const map = new Map<DisputeGroundType, CompositionFact[]>();
    for (const f of facts) {
      const ground = f.findingType
        ? (FINDING_TO_GROUND as Record<string, DisputeGroundType | undefined>)[f.findingType]
        : undefined;
      if (!ground) continue;
      const arr = map.get(ground) ?? [];
      arr.push(f);
      map.set(ground, arr);
    }
    return map;
  }, [facts]);

  function toggleGround(g: DisputeGroundType) {
    setChecked((prev) => {
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
    // Persist a NEWLY GIVEN answer through the existing checklist write (the
    // server gate reads the same stored fact; an already-answered claim skips
    // the write). Fail-closed: a failed save blocks compose.
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
    if (litigation === 'yes') return; // the hold panel below is now the state
    if (checked.size === 0) {
      setError('Select at least one ground — the letter argues only what you select.');
      return;
    }
    onCompose({ grounds: Array.from(checked), adoptedCitations: Array.from(adopted) });
  }

  const litigationHold = litigation === 'yes';
  const busy = submitting || savingAnswer;

  return (
    <ModalShell open={open} onClose={busy ? () => {} : onClose} title="Compose your letter">
      <div className="space-y-6 text-sm">
        {/* 1 — THE FACTS */}
        <section>
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            What your documents show
          </h3>
          {facts.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400">
              No parsed line details are available for this bill.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {facts.map((f, i) => (
                <li key={i} className="rounded-lg bg-gray-50 px-3 py-2 text-gray-700 dark:bg-gray-800/60 dark:text-gray-200">
                  {factStatement(f)}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 2 — THE CATALOG */}
        <section>
          <h3 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Dispute grounds — which of these describe your situation?
          </h3>
          <p className="mb-3 text-[13px] text-gray-500 dark:text-gray-400">
            This is the full list, the same for everyone. Your letter argues only the grounds you
            select. A ground you don’t select stays out of the letter.
          </p>
          <ul className="space-y-2">
            {ALL_DISPUTE_GROUND_TYPES.map((g) => {
              const spec = DISPUTE_GROUND_CATALOG[g];
              const party = groundMemberParty(g);
              const matchesRecipient =
                party === 'both' ||
                (recipient === 'insurer' ? party === 'insurer' : party === 'provider');
              const isChecked = checked.has(g);
              const matched = factsByGround.get(g) ?? [];
              return (
                <li
                  key={g}
                  className={cn(
                    'rounded-xl border px-3 py-2.5',
                    isChecked
                      ? 'border-blue-400 bg-blue-50/60 dark:border-blue-500/60 dark:bg-blue-500/10'
                      : 'border-gray-200 dark:border-gray-700',
                    !matchesRecipient && 'opacity-70',
                  )}
                >
                  <label className={cn('flex items-start gap-2.5', matchesRecipient ? 'cursor-pointer' : 'cursor-default')}>
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-gray-300"
                      checked={isChecked}
                      disabled={!matchesRecipient || busy}
                      onChange={() => toggleGround(g)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-gray-100">{spec.memberLabel}</span>
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                          {party === 'both'
                            ? 'asked of your insurer or the provider'
                            : party === 'insurer'
                              ? 'asked of your insurer'
                              : 'asked of the provider'}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[13px] text-gray-600 dark:text-gray-300">
                        {spec.memberDescription}
                      </span>
                      {!matchesRecipient && (
                        <span className="mt-1 block text-[12px] text-gray-500 dark:text-gray-400">
                          This ground belongs in the {party === 'insurer' ? 'insurer' : 'provider'} letter —
                          compose it from that track.
                        </span>
                      )}
                      <button
                        type="button"
                        className="mt-1 text-[12px] font-medium text-blue-600 hover:underline dark:text-blue-400"
                        onClick={(e) => {
                          e.preventDefault();
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(g)) next.delete(g);
                            else next.add(g);
                            return next;
                          });
                        }}
                      >
                        {expanded.has(g) ? 'Hide what counts as this' : 'What counts as this?'}
                      </button>
                      {expanded.has(g) && (
                        <span className="mt-1 block rounded-lg bg-gray-50 px-2.5 py-1.5 text-[12px] text-gray-600 dark:bg-gray-800/60 dark:text-gray-300">
                          {spec.mappingPlainLanguage}
                        </span>
                      )}
                      {isChecked && (
                        <span className="mt-2 block">
                          {matched.length > 0 ? (
                            <span className="block space-y-1">
                              <span className="block text-[12px] font-medium text-gray-500 dark:text-gray-400">
                                Your facts under this ground:
                              </span>
                              {matched.map((f, i) => (
                                <span key={i} className="block rounded-md bg-white px-2.5 py-1.5 text-[12px] text-gray-700 ring-1 ring-gray-200 dark:bg-gray-900 dark:text-gray-200 dark:ring-gray-700">
                                  {factStatement(f)}
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className="block text-[12px] text-gray-500 dark:text-gray-400">
                              None of the lines we parsed map to this ground. Your letter will state
                              it as your own assertion.
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>

        {/* 3 — CITATIONS (insurer letters only; static menu; none pre-checked) */}
        {citationMenu.length > 0 && (
          <section>
            <h3 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Cite the law in my letter (optional)
            </h3>
            <p className="mb-2 text-[13px] text-gray-500 dark:text-gray-400">
              These are the authorities this letter type can cite, with what each one provides. Pick
              any you want your letter to rely on — or none. Sentences without an adopted citation
              still make the same request in plain language.
            </p>
            <ul className="space-y-1.5">
              {citationMenu.map((key) => {
                const entry = CITATION_REGISTRY[key];
                if (!entry) return null;
                return (
                  <li key={key}>
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 rounded border-gray-300"
                        checked={adopted.has(key)}
                        disabled={busy}
                        onChange={() => toggleCitation(key)}
                      />
                      <span>
                        <span className="block font-medium text-gray-900 dark:text-gray-100">{entry.cite}</span>
                        <span className="block text-[12px] text-gray-600 dark:text-gray-300">{entry.label}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* 4 — THE LITIGATION QUESTION (Rule 8) */}
        <section>
          <h3 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            One required question
          </h3>
          <p className="mb-2 text-gray-700 dark:text-gray-200">
            Has anyone filed a lawsuit over this bill, or have you been served court papers?
          </p>
          <div className="flex gap-3">
            {(['no', 'yes'] as const).map((v) => (
              <label key={v} className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name="litigation"
                  checked={litigation === v}
                  disabled={busy || litigationPreAnswer === 'yes'}
                  onChange={() => setLitigation(v)}
                />
                <span className="text-gray-800 dark:text-gray-100">{v === 'no' ? 'No' : 'Yes'}</span>
              </label>
            ))}
          </div>
          {litigationHold && (
            <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-200">
              {LITIGATION_HOLD_MESSAGE}{' '}
              <Link href="/learn/medical-bill-in-collections" className="font-medium underline">
                Read the self-help guide
              </Link>{' '}
              — it includes how to find free or low-cost legal aid.
            </div>
          )}
        </section>

        {error && <p className="text-[13px] text-red-600 dark:text-red-400">{error}</p>}

        {/* The §81.101(c) conspicuous statement — the step-surface placement. */}
        <p className="border-t border-gray-200 pt-3 text-[12px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
          This product is not a substitute for the advice of an attorney.
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl px-4 py-2 text-[13px] font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          {!litigationHold && (
            <button
              type="button"
              onClick={handleCompose}
              disabled={busy}
              className="rounded-xl bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {busy ? 'Working…' : 'Create my letter from my selections'}
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

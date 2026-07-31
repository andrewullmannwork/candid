"use client";

/**
 * Guided Steps v1 (S297) — Packs C + D on the dispute spine.
 *
 * Pack C "Collections guard-rail": renders when the case is on the collections
 * track. Reuses what exists — the debt_validation letter (onOpenLetter), the
 * outcome flow (onReportOutcome), the EXISTING first-contact date capture
 * (derived row; absent → a pointer into claim details, never a second
 * question), and the deadline engine's window (display label computed by the
 * page from GET-provided values — no third derivation).
 *
 * Pack D "Take it to a regulator": the terminal-zone complaint doors —
 * external_review / final_notice reached, or a resolved loss.
 *
 * Both collapsed by default, optional, attested-only. Booleans persist through
 * the EXISTING dispute checklist plumbing (UnifiedTodo's effChecks/setCheck);
 * notes ride the S297 note extension. Copy VERBATIM from the registry.
 */

import { useState } from "react";
import {
  COMPLAINT_DOORS,
  GUIDE_CHROME,
  PACK_C_LETTER_FOOTNOTE,
  PACK_C_STEPS,
  PACK_C_TITLE,
  PACK_D_CASE_FILE_CHIP,
  PACK_D_DOORS_LEAD,
  PACK_D_DOORS_TITLE,
  PACK_D_META,
  PACK_D_STEPS,
  PACK_D_SUGGESTED_CHIP,
  PACK_D_TITLE,
  packCDeadlineSentence,
  packCFirstContactCopy,
  countCheckboxSteps,
  type ComplaintDoor,
  type GuideStep,
} from "@/lib/guides/pack-registry";
import { Segments, ShowFullStepButton } from "@/components/claims/GuidedPhoneSteps";

function CheckDot({ state }: { state: "done" | "todo" | "derived" | "info" }) {
  if (state === "done" || state === "derived") {
    return (
      <span className="mt-0.5 grid h-[18px] w-[18px] flex-shrink-0 place-items-center rounded-full bg-emerald-600 text-white" aria-hidden>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }
  if (state === "info") {
    return (
      <span className="mt-0.5 grid h-[18px] w-[18px] flex-shrink-0 place-items-center text-gray-400" aria-hidden>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14m0 0l-5-5m5 5l5-5" />
        </svg>
      </span>
    );
  }
  return (
    <span className="mt-0.5 h-[18px] w-[18px] flex-shrink-0 rounded-[5px] border-[1.5px] border-gray-300" aria-hidden />
  );
}

function StepCheckbox({
  step,
  checked,
  onToggle,
  timestampNote,
}: {
  step: GuideStep;
  checked: boolean;
  onToggle: () => void;
  timestampNote?: string | null;
}) {
  if (step.control !== "checkbox" || !step.checkboxLabel) return null;
  return (
    <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-[12.5px] text-gray-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-200"
      />
      <span className="font-medium">{step.checkboxLabel}</span>
      {timestampNote && <span className="text-[11px] text-gray-400">{timestampNote}</span>}
    </label>
  );
}

function NoteInput({
  stepId,
  placeholder,
  value,
  onDraft,
  onCommit,
}: {
  stepId: string;
  placeholder: string;
  value: string;
  onDraft: (stepId: string, v: string) => void;
  onCommit: (stepId: string) => void;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      maxLength={500}
      onChange={(e) => onDraft(stepId, e.target.value)}
      onBlur={() => onCommit(stepId)}
      className="mt-1.5 w-full max-w-md rounded-lg border border-gray-200 px-3 py-[7px] text-[12.5px] text-gray-800 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
    />
  );
}

function usePackNotes(
  notes: Record<string, string>,
  onNote: (key: string, note: string) => void,
) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const valueFor = (key: string) => drafts[key] ?? notes[key] ?? "";
  const draft = (key: string, v: string) => setDrafts((d) => ({ ...d, [key]: v }));
  const commit = (key: string) => {
    const d = drafts[key];
    if (d != null && d !== (notes[key] ?? "")) onNote(key, d);
  };
  return { valueFor, draft, commit };
}

function PackHeader({
  title,
  chip,
  meta,
  done,
  total,
  expanded,
  onToggle,
}: {
  title: string;
  chip?: string | null;
  meta: string;
  done: number;
  total: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      className="flex cursor-pointer flex-wrap items-center gap-2.5 px-4 py-3"
    >
      <span className="text-[14px] font-bold text-gray-900">{title}</span>
      {chip && (
        <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[11.5px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
          {chip}
        </span>
      )}
      {done > 0 ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11.5px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
          {done === total && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 13l4 4L19 7" />
            </svg>
          )}
          {GUIDE_CHROME.doneMeta(done, total)}
        </span>
      ) : (
        <span className="text-[12px] text-gray-500">{meta}</span>
      )}
      <div className="ml-auto">
        <ShowFullStepButton open={expanded} onToggle={onToggle} />
      </div>
    </div>
  );
}

// ── Pack C — collections guard-rail ─────────────────────────────────────────

export function GuidedPackCSection({
  collectorName,
  firstContactDateLabel,
  validationDeadlineLabel,
  checks,
  notes,
  onToggle,
  onNote,
  onOpenLetter,
  onReportOutcome,
  onNeedFirstContact,
}: {
  collectorName: string | null;
  firstContactDateLabel: string | null;
  validationDeadlineLabel: string | null;
  checks: Record<string, boolean>;
  notes: Record<string, string>;
  onToggle: (key: string) => void;
  onNote: (key: string, note: string) => void;
  onOpenLetter: () => void;
  onReportOutcome?: () => void;
  /** Absent first-contact date → route the user to the EXISTING capture. */
  onNeedFirstContact?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const noteState = usePackNotes(notes, onNote);
  const ctx = { collectorName, firstContactDateLabel, validationDeadlineLabel };

  const total = countCheckboxSteps(PACK_C_STEPS);
  const done = PACK_C_STEPS.filter((s) => s.control === "checkbox" && checks[s.id]).length;
  const chip =
    collectorName && firstContactDateLabel
      ? `${collectorName} · first contact ${firstContactDateLabel}`
      : firstContactDateLabel
        ? `first contact ${firstContactDateLabel}`
        : null;

  const derivedCopy = packCFirstContactCopy(ctx);
  const deadlineSentence = packCDeadlineSentence(ctx);

  return (
    <div className="mt-4 rounded-[14px] border border-gray-200 bg-white">
      <PackHeader
        title={PACK_C_TITLE}
        chip={chip}
        meta="optional · keeps collections honest"
        done={done}
        total={total}
        expanded={expanded}
        onToggle={() => setExpanded((e) => !e)}
      />
      {expanded && (
        <div className="flex flex-col gap-3.5 border-t border-gray-100 px-4 pb-4 pt-3">
          {PACK_C_STEPS.map((step) => {
            const checked = checks[step.id] === true;
            if (step.id === "packC:first-contact") {
              return (
                <div key={step.id} className="flex gap-2.5">
                  <CheckDot state={derivedCopy ? "derived" : "todo"} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-bold text-gray-900">{step.title}</div>
                    {derivedCopy ? (
                      <>
                        <div className="mt-0.5 text-[12.5px] leading-[1.55] text-gray-500">
                          <Segments segments={derivedCopy} />
                        </div>
                        <div className="mt-0.5 text-[11px] text-gray-400">
                          derived from your data — nothing to check
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="mt-0.5 text-[12.5px] leading-[1.55] text-gray-500">
                          {typeof step.copy === "string" ? step.copy : null}
                        </div>
                        {onNeedFirstContact && (
                          <button
                            type="button"
                            onClick={onNeedFirstContact}
                            className="mt-1.5 inline-flex items-center rounded-xl border border-gray-200 bg-white px-3.5 py-[7px] text-[12.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                          >
                            Add it in your claim details
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div key={step.id} className="flex gap-2.5">
                <CheckDot state={checked ? "done" : step.control === "cta" ? "info" : "todo"} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-bold text-gray-900">{step.title}</div>
                  <div className="mt-0.5 text-[12.5px] leading-[1.55] text-gray-500">
                    {step.id === "packC:mailed" && deadlineSentence ? (
                      <>
                        <Segments segments={deadlineSentence} />{" "}
                      </>
                    ) : null}
                    {typeof step.copy === "string" ? step.copy : null}
                  </div>
                  {step.id === "packC:mailed" && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={onOpenLetter}
                        className="inline-flex items-center rounded-xl bg-blue-600 px-3.5 py-[7px] text-[12.5px] font-semibold text-white transition-colors hover:bg-blue-700"
                      >
                        {step.cta?.label}
                      </button>
                      <span className="text-[11px] text-gray-400">{PACK_C_LETTER_FOOTNOTE}</span>
                    </div>
                  )}
                  {step.id === "packC:outcome" && onReportOutcome && (
                    <button
                      type="button"
                      onClick={onReportOutcome}
                      className="mt-1.5 inline-flex items-center rounded-xl border border-gray-200 bg-white px-3.5 py-[7px] text-[12.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                    >
                      {step.cta?.label}
                    </button>
                  )}
                  {step.note && (
                    <NoteInput
                      stepId={step.id}
                      placeholder={step.note.placeholder}
                      value={noteState.valueFor(step.id)}
                      onDraft={noteState.draft}
                      onCommit={noteState.commit}
                    />
                  )}
                  <StepCheckbox step={step} checked={checked} onToggle={() => onToggle(step.id)} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Pack D — take it to a regulator ─────────────────────────────────────────

export function GuidedPackDSection({
  suggested,
  checks,
  notes,
  onToggle,
  onNote,
  onDownload,
  onReportOutcome,
}: {
  suggested: Array<ComplaintDoor["id"]>;
  checks: Record<string, boolean>;
  notes: Record<string, string>;
  onToggle: (key: string) => void;
  onNote: (key: string, note: string) => void;
  onDownload: () => void;
  onReportOutcome?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const noteState = usePackNotes(notes, onNote);
  const total = countCheckboxSteps(PACK_D_STEPS);
  const done = PACK_D_STEPS.filter((s) => s.control === "checkbox" && checks[s.id]).length;

  return (
    <div className="mt-4 rounded-[14px] border border-gray-200 bg-white">
      <PackHeader
        title={PACK_D_TITLE}
        meta={PACK_D_META}
        done={done}
        total={total}
        expanded={expanded}
        onToggle={() => setExpanded((e) => !e)}
      />
      {expanded && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3">
          <div className="text-[13.5px] font-bold text-gray-900">{PACK_D_DOORS_TITLE}</div>
          <div className="mt-0.5 text-[12.5px] text-gray-500">{PACK_D_DOORS_LEAD}</div>
          <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {COMPLAINT_DOORS.map((door) => (
              <div key={door.id} className="rounded-xl border border-gray-200 px-3.5 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-bold text-gray-900">
                  {door.name}
                  {suggested.includes(door.id) && (
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10.5px] font-semibold text-blue-700 ring-1 ring-inset ring-blue-200">
                      {PACK_D_SUGGESTED_CHIP}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[12px] leading-[1.5] text-gray-500">{door.desc}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px]">
                  <a
                    href={door.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-blue-700 hover:underline"
                  >
                    {door.href.replace(/^https:\/\/(www\.)?/, "").split("/")[0]}
                  </a>
                  {door.phone && <span className="text-gray-500">{door.phone}</span>}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3.5 flex flex-col gap-3.5">
            {PACK_D_STEPS.map((step) => {
              const checked = checks[step.id] === true;
              return (
                <div key={step.id} className="flex gap-2.5">
                  <CheckDot state={checked ? "done" : step.control === "cta" ? "info" : "todo"} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-bold text-gray-900">{step.title}</div>
                    <div className="mt-0.5 text-[12.5px] leading-[1.55] text-gray-500">
                      {typeof step.copy === "string" ? step.copy : null}
                    </div>
                    {step.id === "packD:docs-ready" && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={onDownload}
                          className="inline-flex items-center rounded-xl border border-gray-200 bg-white px-3.5 py-[7px] text-[12.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                        >
                          {step.cta?.label}
                        </button>
                        <span className="rounded-full bg-purple-50 px-2.5 py-0.5 text-[11px] font-semibold text-purple-700 ring-1 ring-inset ring-purple-200">
                          {PACK_D_CASE_FILE_CHIP}
                        </span>
                      </div>
                    )}
                    {step.id === "packD:outcome" && onReportOutcome && (
                      <button
                        type="button"
                        onClick={onReportOutcome}
                        className="mt-1.5 inline-flex items-center rounded-xl border border-gray-200 bg-white px-3.5 py-[7px] text-[12.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                      >
                        {step.cta?.label}
                      </button>
                    )}
                    {step.note && (
                      <NoteInput
                        stepId={step.id}
                        placeholder={step.note.placeholder}
                        value={noteState.valueFor(step.id)}
                        onDraft={noteState.draft}
                        onCommit={noteState.commit}
                      />
                    )}
                    <StepCheckbox step={step} checked={checked} onToggle={() => onToggle(step.id)} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

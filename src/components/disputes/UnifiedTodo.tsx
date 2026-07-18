"use client";

/**
 * UnifiedTodo — "What you need to do" (Surface 4, clarity redesign v3).
 *
 * One continuously-numbered checklist above the letter, merging the prep
 * signals ("What we need from you"), the send steps, and the after-sent
 * guidance into three groups:
 *
 *   GET IT READY   — provider mailing address (real ProviderAddressModal via
 *                    onAddProviderAddress), patient-identity confirm (inline
 *                    two-choice expansion → real confirm-patient-identity POST
 *                    or edit-the-letter), "Confirm the claim details" (inline
 *                    expansion embedding the REAL CaseNeedsPanel via children),
 *                    and the optional read-through.
 *   SEND IT        — Download & sign (real download) → Mail it certified
 *                    (check-off) → Mark it as sent (inline confirm → real
 *                    mark-sent POST).
 *   AFTER IT'S SENT — watch / follow up / escalate guidance rows; locked until
 *                    sent, then checkable.
 *
 * Data rules: every state shown is derived from live dispute data (address on
 * file, name mismatch, sent status, response-due date). Check-offs that have
 * no backing store (mailed-it, after-sent guidance, read-through, details
 * confirmation) are session-local, exactly like the prototype.
 */

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

// ── Types ───────────────────────────────────────────────────────────────────

export interface UnifiedTodoProps {
  /** "$775.00" — used in "Finish this list to get your $X moving." */
  amountLabel: string | null;
  sent: boolean;
  /** Formatted sent date ("Jul 3, 2026") — shown once sent. */
  sentDateLabel: string | null;
  /** Formatted response-due date — governing deadline, else sent + 30 days. */
  responseDueLabel: string | null;

  /** Who this letter mails to (letterRecipientKind) — drives the mailing-
   *  address needed row (insurer appeals address vs provider address) and the
   *  after-sent guidance copy (appeals line vs billing office). Collector
   *  letters follow the provider branch. */
  recipientKind: "insurer" | "provider" | "collector";

  // GET IT READY — mailing-address rows (which one is REQUIRED depends on
  // recipientKind; the other stays available inside claim details).
  providerAddressOnFile: boolean;
  onAddProviderAddress: () => void;
  insurerAddressOnFile: boolean;
  onAddInsurerAddress: () => void;

  // GET IT READY — patient identity row (renders only when a mismatch exists).
  // "me" → letter name becomes the account name; "dependent" → keeps the bill
  // name; "wrong" → correctedName fills the letter. All three resolve the
  // mismatch via the real confirm-patient-identity flow in the parent.
  nameMismatch: { billName: string; profileName: string } | null;
  nameResolved: boolean;
  onResolvePatient: (choice: "me" | "dependent" | "wrong", correctedName?: string) => void;

  // GET IT READY — claim-details expansion (embeds the real CaseNeedsPanel)
  children?: ReactNode;

  // Optional read-through
  onOpenLetter: () => void;

  // SEND IT
  onDownload: () => void;
  onMarkSent: () => void;
  markingSent: boolean;
}

type RowState = "todo" | "done" | "locked" | "skipped";

// ── Icons ───────────────────────────────────────────────────────────────────

function CheckIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 11V7a5 5 0 0110 0v4M5 11h14v10H5V11z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

// ── Row chrome ──────────────────────────────────────────────────────────────

function TodoDot({
  state,
  num,
  optional,
  onToggle,
}: {
  state: RowState;
  num: number | null;
  optional?: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={state === "locked" || (!onToggle && state !== "done")}
      onClick={() => {
        if (onToggle && state !== "locked") onToggle();
      }}
      className={cn(
        "mt-0.5 grid h-[22px] w-[22px] flex-shrink-0 place-items-center rounded-full text-[11px] font-bold",
        state === "done"
          ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-300"
          : state === "locked"
            ? "bg-white text-gray-400 ring-[1.5px] ring-inset ring-gray-200"
            : optional
              ? "bg-gray-50 text-gray-400 ring-[1.5px] ring-inset ring-gray-200"
              : "bg-white text-gray-500 ring-[1.5px] ring-inset ring-gray-300",
        onToggle && state !== "locked" ? "cursor-pointer" : "cursor-default",
      )}
      aria-hidden={!onToggle}
      tabIndex={onToggle ? 0 : -1}
    >
      {state === "done" ? <CheckIcon /> : state === "locked" ? <LockIcon /> : optional ? <PlusIcon /> : num}
    </button>
  );
}

interface RowDef {
  id: string;
  title: string;
  sub?: ReactNode;
  state: RowState;
  required: boolean;
  cta?: string;
  onDo?: () => void;
  onSkip?: () => void;
  /** Checkable directly via the dot (send/after check-offs). */
  checkable?: boolean;
  /** Inline confirm instead of immediate action (Mark as sent). */
  confirm?: boolean;
}

// ── Component ───────────────────────────────────────────────────────────────

export function UnifiedTodo({
  amountLabel,
  sent,
  sentDateLabel,
  responseDueLabel,
  recipientKind,
  providerAddressOnFile,
  onAddProviderAddress,
  insurerAddressOnFile,
  onAddInsurerAddress,
  nameMismatch,
  nameResolved,
  onResolvePatient,
  children,
  onOpenLetter,
  onDownload,
  onMarkSent,
  markingSent,
}: UnifiedTodoProps) {
  const [expanded, setExpanded] = useState<"patient" | "details" | null>(null);
  const [who, setWho] = useState<"me" | "dependent" | "wrong">("me");
  const [correctedName, setCorrectedName] = useState("");
  const [detailsDone, setDetailsDone] = useState(false);
  const [readState, setReadState] = useState<"todo" | "done" | "skipped">("todo");
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [asking, setAsking] = useState(false);
  const toggleCheck = (id: string) => setChecks((c) => ({ ...c, [id]: !c[id] }));

  const lockIfSent = (s: RowState): RowState => (sent && s === "todo" ? "locked" : s);

  // GET IT READY — the REQUIRED mailing-address row targets whoever this
  // letter actually mails to; the other address stays editable inside the
  // claim-details expansion.
  const insurerMailing = recipientKind === "insurer";
  const prepRows: RowDef[] = [
    {
      id: "address",
      title: insurerMailing
        ? "Add your insurer's appeals address"
        : "Add the provider's mailing address",
      sub: insurerMailing
        ? "The appeal has nowhere to be mailed without it."
        : "The letter has nowhere to be mailed without it.",
      state: lockIfSent((insurerMailing ? insurerAddressOnFile : providerAddressOnFile) ? "done" : "todo"),
      required: true,
      cta: "Add address",
      onDo: insurerMailing ? onAddInsurerAddress : onAddProviderAddress,
    },
    ...(nameMismatch
      ? [
          {
            id: "patient",
            title: "Confirm who the patient is",
            sub: (
              <>
                The bill lists <strong className="text-gray-900">&ldquo;{nameMismatch.billName}&rdquo;</strong>; your
                account is <strong className="text-gray-900">{nameMismatch.profileName}</strong>.
              </>
            ),
            state: lockIfSent(nameResolved ? "done" : "todo"),
            required: true,
            cta: "Resolve name",
            onDo: () => setExpanded((e) => (e === "patient" ? null : "patient")),
          } satisfies RowDef,
        ]
      : []),
    {
      id: "details",
      title: "Confirm the claim details",
      sub: "Addresses, EOB, plan costs, and the insurance this letter uses.",
      state: lockIfSent(detailsDone ? "done" : "todo"),
      required: true,
      cta: expanded === "details" ? "Close" : "Confirm details",
      onDo: () => setExpanded((e) => (e === "details" ? null : "details")),
    },
    {
      id: "review",
      title: "Read it through once",
      sub: "Skim top to bottom and edit anything that doesn't sound like you.",
      state: sent && readState === "todo" ? "locked" : readState === "done" ? "done" : readState === "skipped" ? "skipped" : "todo",
      required: false,
      cta: "Open letter",
      onDo: () => {
        onOpenLetter();
        setReadState("done");
      },
      onSkip: () => setReadState("skipped"),
    },
  ];

  // SEND IT
  const sendRows: RowDef[] = [
    {
      id: "download",
      title: "Download & sign the letter",
      sub: "Print it, sign in ink, keep a copy.",
      state: sent || checks.download ? "done" : "todo",
      required: true,
      cta: "Download",
      onDo: () => {
        onDownload();
        setChecks((c) => ({ ...c, download: true }));
      },
      checkable: true,
    },
    {
      id: "mailcert",
      title: "Mail it certified",
      sub: "USPS Form 3811 (return receipt) — your proof of delivery.",
      state: sent || checks.mailcert ? "done" : "todo",
      required: true,
      cta: "Done — I mailed it",
      onDo: () => toggleCheck("mailcert"),
      checkable: true,
    },
    {
      id: "marksent",
      title: "Mark it as sent",
      sub: "Starts the clock on their response and schedules your follow-up reminders.",
      state: sent ? "done" : "todo",
      required: true,
      cta: "Mark as sent",
      onDo: () => setAsking(true),
      confirm: true,
    },
  ];

  // AFTER IT'S SENT — guidance copy follows the recipient (appeal to the
  // insurer vs a provider/collector-directed dispute).
  const afterRows: RowDef[] = [
    {
      id: "watch",
      title: "Watch for a reply",
      sub: insurerMailing
        ? "Most insurers must respond within 30 days of receipt."
        : "Providers and collectors typically respond within 30 days.",
    },
    {
      id: "followup",
      title: "Follow up at day 30",
      sub: insurerMailing
        ? "No response? Call the appeals line with your tracking number."
        : "No response? Call the billing office with your tracking number.",
    },
    {
      id: "escalate",
      title: "Escalate if unresolved",
      sub: insurerMailing
        ? "Your state Insurance Commissioner or a healthcare attorney can step in."
        : "Your state Attorney General's consumer division or a healthcare attorney can step in.",
    },
  ].map((r) => ({
    ...r,
    required: true,
    checkable: true,
    cta: "Mark done",
    state: (!sent ? "locked" : checks[r.id] ? "done" : "todo") as RowState,
    onDo: () => {
      if (sent) toggleCheck(r.id);
    },
  }));

  const all = [...prepRows, ...sendRows, ...afterRows];
  const required = all.filter((r) => r.required);
  const reqDone = required.filter((r) => r.state === "done").length;
  const current = all.find((r) => r.required && r.state === "todo") ?? null;

  let n = 0;
  const groups: Array<{ id: string; label: string; rows: RowDef[] }> = [
    { id: "ready", label: "Get it ready", rows: prepRows },
    { id: "send", label: "Send it", rows: sendRows },
    { id: "after", label: "After it's sent", rows: afterRows },
  ];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold tracking-[-0.005em] text-gray-900">What you need to do</h3>
          <p className="mt-0.5 text-[12.5px] text-gray-500">
            {sent
              ? `Sent${sentDateLabel ? ` ${sentDateLabel}` : ""}${responseDueLabel ? ` · response due by ${responseDueLabel}` : ""}`
              : amountLabel
                ? `Finish this list to get your ${amountLabel} moving.`
                : "Finish this list to get your appeal moving."}
          </p>
        </div>
        <span className="flex-shrink-0 rounded-full bg-blue-50 px-2.5 py-1 text-[12px] font-bold tabular-nums text-blue-700 ring-1 ring-inset ring-blue-200">
          {reqDone}/{required.length}
        </span>
      </div>

      {groups.map((g) => (
        <div key={g.id} className="mt-1.5">
          <div className="mb-1 mt-3 text-[10px] font-bold uppercase tracking-[0.1em] text-gray-400">
            {g.label}
          </div>
          {g.rows.map((row) => {
            if (row.required) n += 1;
            const num = row.required ? n : null;
            const isCurrent = current?.id === row.id;
            // Prep rows stay re-editable after completion until the letter is
            // marked sent (the milestone that locks them).
            const updatable =
              !sent && row.state === "done" && ["address", "patient", "details"].includes(row.id);
            return (
              <div key={row.id}>
                <div
                  className={cn(
                    "flex flex-wrap items-start gap-2.5 rounded-xl px-2 py-2 sm:flex-nowrap",
                    isCurrent && "bg-blue-50 ring-1 ring-inset ring-blue-200",
                    row.state === "locked" && "opacity-55",
                  )}
                >
                  <TodoDot
                    state={row.state}
                    num={num}
                    optional={!row.required}
                    onToggle={row.checkable ? row.onDo : undefined}
                  />
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div
                      className={cn(
                        "flex flex-wrap items-center gap-2 text-[13px] font-semibold leading-snug",
                        row.state === "done" ? "text-gray-400" : "text-gray-900",
                        row.state === "skipped" && "text-gray-400 line-through",
                      )}
                    >
                      {row.title}
                      {!row.required && row.state === "todo" && (
                        <span className="rounded-full border border-gray-200 bg-gray-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.07em] text-gray-400 no-underline">
                          Optional
                        </span>
                      )}
                    </div>
                    {row.sub && row.state !== "done" && (
                      <div className="mt-0.5 text-[11.5px] leading-relaxed text-gray-500">{row.sub}</div>
                    )}
                  </div>
                  {/* Row action */}
                  {row.state === "todo" && row.cta && !row.confirm && row.required && (
                    <button
                      type="button"
                      onClick={row.onDo}
                      className={cn(
                        "flex-shrink-0 self-center rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors",
                        "max-sm:basis-full",
                        isCurrent
                          ? "bg-blue-600 text-white hover:bg-blue-700"
                          : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
                      )}
                    >
                      {row.cta}
                    </button>
                  )}
                  {row.state === "todo" && row.confirm && !asking && (
                    <button
                      type="button"
                      onClick={row.onDo}
                      className={cn(
                        "flex-shrink-0 self-center rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors",
                        "max-sm:basis-full",
                        isCurrent
                          ? "bg-blue-600 text-white hover:bg-blue-700"
                          : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
                      )}
                    >
                      {row.cta}
                    </button>
                  )}
                  {/* Re-open affordance — done prep rows stay editable until sent. */}
                  {updatable && (
                    <button
                      type="button"
                      onClick={row.onDo}
                      className="flex-shrink-0 self-center text-[12px] font-semibold text-blue-600 hover:underline"
                    >
                      Update
                    </button>
                  )}
                  {row.state === "todo" && !row.required && (
                    <span className="flex flex-shrink-0 items-center gap-2.5 self-center max-sm:basis-full">
                      <button
                        type="button"
                        onClick={row.onDo}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                      >
                        {row.cta}
                      </button>
                      <button
                        type="button"
                        onClick={row.onSkip}
                        className="text-[12px] font-semibold text-gray-400 hover:underline"
                      >
                        Skip
                      </button>
                    </span>
                  )}
                </div>

                {/* Inline expansion — patient identity (three choices, all
                    resolving through the real confirm-patient-identity flow;
                    "me"/"wrong" also fill the letter name in the parent).
                    Re-openable after completion until the letter is sent. */}
                {row.id === "patient" && expanded === "patient" && !sent && nameMismatch && (
                  <div className="animate-fade-in mx-2 mb-2.5 rounded-[14px] border border-blue-200 bg-white p-4 shadow-[0_14px_30px_-20px_rgba(37,99,235,0.35)] sm:ml-8">
                    <div className="mb-3 text-[13px] leading-relaxed text-gray-600">
                      The bill lists <strong className="text-gray-900">&ldquo;{nameMismatch.billName}&rdquo;</strong>;
                      your account is <strong className="text-gray-900">{nameMismatch.profileName}</strong>. Which is right?
                    </div>
                    <div className="space-y-2">
                      <ChoiceCard
                        selected={who === "me"}
                        tone="good"
                        title="That's me"
                        desc={`The bill means you — the letter will use your account name, ${nameMismatch.profileName}.`}
                        onSelect={() => setWho("me")}
                      />
                      <ChoiceCard
                        selected={who === "dependent"}
                        tone="good"
                        title="That's right — it's one of my dependents"
                        desc={`The visit was for ${nameMismatch.billName}, covered on your plan. The letter keeps their name.`}
                        onSelect={() => setWho("dependent")}
                      />
                      <ChoiceCard
                        selected={who === "wrong"}
                        tone="warn"
                        title="That name is wrong"
                        desc="Type the patient's correct name and we'll fill the letter."
                        onSelect={() => setWho("wrong")}
                      />
                    </div>
                    {who === "wrong" && (
                      <input
                        type="text"
                        value={correctedName}
                        onChange={(e) => setCorrectedName(e.target.value)}
                        placeholder="Patient's full name"
                        autoFocus
                        className="mt-2.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                      />
                    )}
                    <div className="mt-3 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setExpanded(null)}
                        className="rounded-lg px-3 py-1.5 text-[12.5px] font-semibold text-gray-500 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={who === "wrong" && correctedName.trim().length === 0}
                        onClick={() => {
                          onResolvePatient(who, who === "wrong" ? correctedName.trim() : undefined);
                          setExpanded(null);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <CheckIcon size={12} /> Confirm
                      </button>
                    </div>
                  </div>
                )}

                {/* Inline expansion — claim details. The embedded (chromeless)
                    CaseNeedsPanel and this wrapper read as ONE card; the
                    wrapper owns the border, padding, and footer actions. */}
                {row.id === "details" && expanded === "details" && (
                  <div className="animate-fade-in mx-2 mb-2.5 rounded-[14px] border border-blue-200 bg-white p-4 shadow-[0_14px_30px_-20px_rgba(37,99,235,0.35)] sm:ml-8 sm:p-5">
                    {children}
                    <div className="mt-3 flex justify-end gap-2 border-t border-gray-100 pt-3">
                      <button
                        type="button"
                        onClick={() => setExpanded(null)}
                        className="rounded-lg px-3 py-1.5 text-[12.5px] font-semibold text-gray-500 hover:bg-gray-50"
                      >
                        Close
                      </button>
                      {!sent && (
                        <button
                          type="button"
                          onClick={() => {
                            setDetailsDone(true);
                            setExpanded(null);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-blue-700"
                        >
                          <CheckIcon size={12} /> These are right
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Inline confirm — Mark as sent */}
                {row.id === "marksent" && asking && !sent && (
                  <div className="animate-fade-in mx-2 mb-2 flex flex-wrap items-center justify-between gap-2.5 rounded-[10px] border border-blue-200 bg-blue-50 px-3 py-2.5 text-[12.5px] font-semibold text-blue-900 sm:ml-8">
                    <span>Did you actually mail it?</span>
                    <span className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setAsking(false)}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-semibold text-gray-700 hover:bg-gray-50"
                      >
                        Not yet
                      </button>
                      <button
                        type="button"
                        disabled={markingSent}
                        onClick={() => {
                          setAsking(false);
                          onMarkSent();
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        <CheckIcon size={12} /> {markingSent ? "Saving…" : "Yes — start the clock"}
                      </button>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}

// ── Choice card (patient-identity radios) ───────────────────────────────────

function ChoiceCard({
  selected,
  tone,
  title,
  desc,
  onSelect,
}: {
  selected: boolean;
  tone: "good" | "warn";
  title: string;
  desc: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
        selected
          ? tone === "good"
            ? "border-emerald-300 bg-emerald-50/60"
            : "border-amber-300 bg-amber-50/60"
          : "border-gray-200 bg-white hover:border-gray-300",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid h-[18px] w-[18px] flex-shrink-0 place-items-center rounded-full border-2",
          selected
            ? tone === "good"
              ? "border-emerald-500"
              : "border-amber-500"
            : "border-gray-300",
        )}
        aria-hidden
      >
        {selected && (
          <span
            className={cn(
              "h-[8px] w-[8px] rounded-full",
              tone === "good" ? "bg-emerald-500" : "bg-amber-500",
            )}
          />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-gray-900">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-gray-500">{desc}</span>
      </span>
    </button>
  );
}

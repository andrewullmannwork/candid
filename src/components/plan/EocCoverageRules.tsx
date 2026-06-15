"use client";
// ============================================================================
// EOC coverage-rule surfaces for /plan (S202, block spec §9). Renders the
// reader-resolution data emitted by /api/plan/analyze when eoc_reader_resolution_v1
// is ON. All three render only when their data is present, so a flag-OFF (or
// non-EOC) plan shows nothing new — graceful degradation, no FE flag check needed.
//   • EocServiceCoverageDetail — per-service inline (Surface 1)
//   • EocPriorAuthCard         — plan-wide + by-location aggregate cards (Surface 2)
//   • EocAboutPlanCard         — "Good to know" member info (Surface 3)
// ============================================================================
import { useState } from "react";
import type {
  PaStatement,
  ByLocationGroup,
  AboutGroup,
  ScopeChip,
  ServiceCoverageDetail,
} from "@/lib/plan/eoc-reader-resolution";

const ICON = {
  check: "M5 13l4 4L19 7",
  warn: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z",
  chevron: "M19 9l-7 7-7-7",
};

function Svg({ d, className }: { d: string; className: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  );
}

function Chips({ chips }: { chips: ScopeChip[] }) {
  return (
    <>
      {chips.map((c, i) => (
        <span
          key={i}
          className={
            "inline-flex items-center text-[10.5px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap " +
            (c.kind === "plan" ? "bg-gray-100 text-gray-600" : "bg-blue-50 text-blue-700")
          }
        >
          {c.label}
        </span>
      ))}
    </>
  );
}

// The cite-grade quote block (emerald left-accent). Reused as the in-app receipt.
function QuoteBlock({ quote, indent }: { quote: string; indent?: boolean }) {
  return (
    <div className={"border-l-4 border-emerald-300 bg-emerald-50/60 rounded-xl px-3.5 py-3 mt-2" + (indent ? " ml-7" : "")}>
      <blockquote className="text-[13.5px] italic text-slate-700 leading-relaxed">&ldquo;{quote.trim()}&rdquo;</blockquote>
    </div>
  );
}

// A tappable prior-auth statement row whose quote reveals inline below it.
function PaRow({ stmt }: { stmt: PaStatement }) {
  const [open, setOpen] = useState(false);
  const isWaived = stmt.polarity === "waived";
  const canReveal = !!stmt.quote;
  return (
    <div>
      <button
        type="button"
        onClick={() => canReveal && setOpen((o) => !o)}
        aria-expanded={canReveal ? open : undefined}
        className={
          "w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl text-left transition-colors " +
          (canReveal ? "hover:bg-gray-50/80 cursor-pointer" : "cursor-default")
        }
      >
        <Svg
          d={isWaived ? ICON.check : ICON.warn}
          className={"w-[15px] h-[15px] shrink-0 " + (isWaived ? "text-emerald-600" : "text-amber-600")}
        />
        {stmt.isException && (
          <span className="inline-flex items-center text-[9.5px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 ring-1 ring-amber-200 px-1.5 py-0.5 rounded-full shrink-0">
            Exception
          </span>
        )}
        <span className="flex-1 min-w-0 flex flex-wrap items-center gap-2">
          <Chips chips={stmt.scopeChips} />
          <span className="text-sm text-gray-700 leading-snug">{stmt.text}</span>
        </span>
        {canReveal && (
          <Svg d={ICON.chevron} className={"w-4 h-4 shrink-0 text-gray-300 transition-transform " + (open ? "rotate-180" : "")} />
        )}
      </button>
      {open && stmt.quote && <QuoteBlock quote={stmt.quote} indent />}
    </div>
  );
}

interface PriorAuthCardProps {
  eyebrow: string;
  title: string;
  statements?: PaStatement[]; // plan-wide (flat)
  groups?: ByLocationGroup[]; // by-location (grouped)
}

/** Surface 2 — a collapsible aggregate prior-auth card (plan-wide OR by-location). */
export function EocPriorAuthCard({ eyebrow, title, statements, groups }: PriorAuthCardProps) {
  const [open, setOpen] = useState(true);
  const count = statements?.length ?? (groups?.reduce((n, g) => n + g.statements.length, 0) ?? 0);
  if (count === 0) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-start justify-between gap-3 text-left">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-blue-600">{eyebrow}</p>
          <h3 className="mt-1 text-base font-semibold text-gray-900 leading-tight">{title}</h3>
        </div>
        <span className="flex items-center gap-2 shrink-0 text-[13px] font-semibold text-gray-500 whitespace-nowrap">
          {count} {count === 1 ? "rule" : "rules"}
          <Svg d={ICON.chevron} className={"w-[18px] h-[18px] text-gray-400 transition-transform " + (open ? "rotate-180" : "")} />
        </span>
      </button>

      {open && (
        <div className="mt-2.5">
          <div className="flex items-center gap-1.5 text-[11.5px] text-gray-500">
            <Svg d={ICON.check} className="w-3.5 h-3.5 text-emerald-600" />
            Quoted from your plan document — tap any rule for the exact wording.
          </div>

          {statements && (
            <div className="mt-3">
              {statements.map((s, i) => (
                <PaRow key={i} stmt={s} />
              ))}
            </div>
          )}

          {groups &&
            groups.map((g) => (
              <div key={g.setting} className="mt-3">
                <p className="px-2.5 mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{g.setting}</p>
                {g.statements.map((s, i) => (
                  <PaRow key={i} stmt={s} />
                ))}
              </div>
            ))}

          <p className="mt-4 pt-3.5 border-t border-gray-100 text-xs italic text-gray-400 leading-snug">
            These are your plan&rsquo;s stated rules &mdash; confirm with your plan before scheduling.
          </p>
        </div>
      )}
    </div>
  );
}

/** Surface 3 — the collapsible "Good to know" member-info card. */
export function EocAboutPlanCard({ groups }: { groups: AboutGroup[] }) {
  const [open, setOpen] = useState(false);
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  if (count === 0) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-3 text-left">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-blue-600">About your plan</p>
          <h3 className="mt-1 text-base font-semibold text-gray-900 leading-tight">Good to know</h3>
        </div>
        <span className="flex items-center gap-2 shrink-0 text-[13px] font-medium text-gray-500 whitespace-nowrap">
          {count} {count === 1 ? "detail" : "details"}
          <Svg d={ICON.chevron} className={"w-[18px] h-[18px] text-gray-400 transition-transform " + (open ? "rotate-180" : "")} />
        </span>
      </button>

      {open && (
        <div className="mt-4 pt-4 border-t border-gray-100 flex flex-col gap-5">
          {groups.map((g) => (
            <div key={g.label}>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{g.label}</p>
              <div className="flex flex-col gap-2">
                {g.items.map((it, i) => (
                  <p key={i} className="text-sm text-gray-600 leading-snug">{it.text}</p>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Surface 1 — per-service detail (rendered inside an expanded service) ─────
export type EocServiceItem = Partial<ServiceCoverageDetail> & { priorAuthRequired?: boolean | null };

function SectionLabel({ children, tone }: { children: React.ReactNode; tone?: "amber" | "emerald" }) {
  const color = tone === "amber" ? "text-amber-700" : tone === "emerald" ? "text-emerald-700" : "text-gray-500";
  return <p className={"text-[11px] font-semibold uppercase tracking-wide " + color}>{children}</p>;
}

/** Surface 1 — the per-service prior-auth + medical-necessity detail + one consolidated quote block. */
export function EocServiceCoverageDetail({ item }: { item: EocServiceItem }) {
  const hasPa = !!(item.priorAuthCriteria || (item.priorAuthAllCriteria && item.priorAuthAllCriteria.length > 0));
  const mn = item.medicalNecessityCriteria ?? [];
  const hasMn = !!(item.medicalNecessityText || mn.length > 0);
  if (!hasPa && !hasMn) return null;

  // Consolidated cite block — every verified excerpt for this service, in one calm place.
  const quotes: { label: string; text: string }[] = [];
  if (item.priorAuthSourceExcerpt) quotes.push({ label: "Prior authorization", text: item.priorAuthSourceExcerpt });
  for (const m of mn) if (m.excerpt) quotes.push({ label: "Medical necessity", text: m.excerpt });

  const paCriteria = item.priorAuthAllCriteria && item.priorAuthAllCriteria.length > 0 ? item.priorAuthAllCriteria : item.priorAuthCriteria ? [item.priorAuthCriteria] : [];
  const icd = item.diagnosisQualifiers ?? [];

  return (
    <div className="flex flex-col gap-4">
      {hasPa && (
        <div>
          <SectionLabel tone="amber">Prior authorization</SectionLabel>
          <p className="mt-1.5 text-sm font-semibold text-amber-700 leading-snug">Required before this service.</p>
          {paCriteria.map((c, i) => (
            <p key={i} className="mt-1 text-sm text-gray-600 leading-relaxed">{c}</p>
          ))}
        </div>
      )}

      {hasMn && (
        <div>
          <SectionLabel>Medical necessity</SectionLabel>
          {item.medicalNecessityText && <p className="mt-1.5 text-sm text-gray-600 leading-relaxed">{item.medicalNecessityText}</p>}
          {mn.filter((m) => m.text && m.text !== item.medicalNecessityText).map((m, i) => (
            <p key={i} className="mt-1 text-sm text-gray-600 leading-relaxed">{m.text}</p>
          ))}
          {icd.length > 0 && (
            <>
              <p className="mt-2.5 text-xs text-gray-400">Applies to these diagnoses (ICD-10)</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {icd.map((c, i) => (
                  <span key={i} className="font-mono text-[11.5px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-md">{c}</span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {quotes.length > 0 && (
        <div className="border-l-4 border-emerald-300 bg-emerald-50/60 rounded-xl px-4 py-3.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 flex items-center gap-1">
            <Svg d={ICON.check} className="w-3 h-3" /> Verified from your plan document
          </p>
          <div className="mt-2.5 flex flex-col">
            {quotes.map((q, i) => (
              <div key={i} className={i > 0 ? "pt-3 mt-3 border-t border-emerald-200/60" : ""}>
                {quotes.length > 1 && <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-600">{q.label}</p>}
                <blockquote className="mt-1 text-[13.5px] italic text-slate-700 leading-relaxed">&ldquo;{q.text.trim()}&rdquo;</blockquote>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

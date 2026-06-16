"use client";
// ============================================================================
// EOC coverage-rule surfaces for /plan (S202, block spec §9) — the "calm"
// redesign (handoff-coverage-rules 3). The verbatim plan-document proof is
// ALWAYS one tap away behind a quiet disclosure — never a wall of green.
//   • EocServiceCoverageDetail — per-service inline (Surface 1)
//   • EocPriorAuthCard         — one plan-level card, Needs-approval / No-approval (Surface 2)
//   • EocAboutPlanCard         — "Good to know" collapsible sub-groups (Surface 3)
// Each renders only when its data is present (flag-OFF/non-EOC → nothing new).
// ============================================================================
import { useState, useEffect } from "react";
import type { PaStatement, ScopeChip, AboutGroup, ServiceCoverageDetail } from "@/lib/plan/eoc-reader-resolution";

const ICON = {
  check: "M5 13l4 4L19 7",
  warn: "M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z M12 9v4 M12 17h.01",
  chevron: "M6 9l6 6 6-6",
  shield: "M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3Z M9 12l2 2 4-4",
};
function Svg({ d, className, sw = 2 }: { d: string; className: string; sw?: number }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      {d.split(" M").map((seg, i) => (
        <path key={i} d={(i === 0 ? "" : "M") + seg} />
      ))}
    </svg>
  );
}

// ── The calm proof disclosure: a quiet trust line; tap to reveal verbatim quote(s) ──
function ProofDisclosure({ items }: { items: { label: string; text: string }[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const multi = items.length > 1;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3.5 pt-3.5 border-t border-gray-100 text-left"
      >
        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-emerald-700 whitespace-nowrap">
          <Svg d={ICON.shield} className="w-3.5 h-3.5" sw={1.9} /> Verified from your plan document
        </span>
        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-gray-400 whitespace-nowrap">
          {open ? "Hide wording" : "Show exact wording"}
          <Svg d={ICON.chevron} className={"w-3.5 h-3.5 transition-transform " + (open ? "rotate-180" : "")} sw={2.2} />
        </span>
      </button>
      {open && (
        <div className="mt-[15px] flex flex-col gap-[15px]">
          {items.map((q, i) => (
            <div key={i} className="pl-[15px] border-l-2 border-emerald-300">
              {multi && <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-emerald-600">{q.label}</div>}
              <p className="text-[14px] italic text-slate-600 leading-relaxed">&ldquo;{q.text.trim()}&rdquo;</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Per-row inline reveal used inside the plan-level prior-auth card ──
function InlineWording({ quote }: { quote: string | null }) {
  const [open, setOpen] = useState(false);
  if (!quote) return null;
  return (
    <div className="mt-2.5">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-emerald-700">
        {open ? "Hide wording" : "Show exact wording"}
        <Svg d={ICON.chevron} className={"w-3 h-3 transition-transform " + (open ? "rotate-180" : "")} sw={2.2} />
      </button>
      {open && <p className="mt-2.5 pl-[15px] border-l-2 border-emerald-300 text-[14px] italic text-slate-600 leading-relaxed">&ldquo;{quote.trim()}&rdquo;</p>}
    </div>
  );
}

function Chips({ chips }: { chips: ScopeChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-2.5">
      {chips.map((c, i) =>
        c.kind === "exc" ? (
          <span key={i} className="inline-flex items-center text-[10px] font-semibold uppercase tracking-[0.05em] px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200">
            {c.label}
          </span>
        ) : (
          <span key={i} className="inline-flex items-center text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700">
            {c.label}
          </span>
        ),
      )}
    </div>
  );
}

function PaGroup({ tone, label, rows }: { tone: "amber" | "emerald"; label: string; rows: PaStatement[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className={"flex items-center gap-2.5 text-[11px] font-bold uppercase tracking-[0.09em] " + (tone === "amber" ? "text-amber-700" : "text-emerald-700")}>
        <span className={"w-[7px] h-[7px] rounded-full shrink-0 " + (tone === "amber" ? "bg-amber-500" : "bg-emerald-500")} />
        {label}
        <span className="ml-auto text-[11px] font-semibold text-gray-400">{rows.length}</span>
      </div>
      <div className="mt-1">
        {rows.map((r, i) => (
          <div key={i} className="py-4 border-t border-gray-100 first:border-t-0">
            <Chips chips={r.scopeChips} />
            <div className="flex gap-3 items-start">
              <Svg d={tone === "amber" ? ICON.warn : ICON.check} className={"w-4 h-4 shrink-0 mt-px " + (tone === "amber" ? "text-amber-600" : "text-emerald-600")} sw={tone === "amber" ? 1.9 : 2.4} />
              <div className="flex-1 min-w-0">
                <div className="text-[15px] text-gray-700 leading-[1.55]">{r.text}</div>
                <InlineWording quote={r.quote} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Surface 2 — one plan-level prior-auth card, collapsed by default; auto-opens when deep-linked. */
export function EocPriorAuthCard({ requires, noApproval, anchorId }: { requires: PaStatement[]; noApproval: PaStatement[]; anchorId?: string }) {
  const [open, setOpen] = useState(false);
  // Auto-open when the page is deep-linked to this card (e.g. the "Prior auth
  // required" pill links to #anchorId) — on initial load and on hash change.
  useEffect(() => {
    if (!anchorId) return;
    const check = () => {
      if (window.location.hash === "#" + anchorId) setOpen(true);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [anchorId]);

  const total = requires.length + noApproval.length;
  if (total === 0) return null;
  return (
    <div id={anchorId} className="bg-white border border-gray-200 rounded-[20px] p-[22px] shadow-sm scroll-mt-20">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full flex items-start justify-between gap-3.5 text-left">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-blue-600">Prior authorization</div>
          <h3 className="mt-2 text-[17px] font-semibold text-gray-900 tracking-[-0.01em]">When your plan needs approval</h3>
        </div>
        <span className="inline-flex items-center gap-2 shrink-0 text-[13px] font-semibold text-gray-500 whitespace-nowrap">
          {total} {total === 1 ? "rule" : "rules"}
          <Svg d={ICON.chevron} className={"w-[18px] h-[18px] text-gray-400 transition-transform " + (open ? "rotate-180" : "")} sw={2.2} />
        </span>
      </button>
      {open && (
        <>
          <p className="mt-1.5 text-[13px] text-gray-500 leading-snug">The plan-wide rules, in plain language — tap any rule for the exact wording.</p>
          <div className="mt-[22px] flex flex-col gap-7">
            <PaGroup tone="amber" label="Needs approval" rows={requires} />
            <PaGroup tone="emerald" label="No approval needed" rows={noApproval} />
          </div>
          <p className="mt-[22px] pt-4 border-t border-gray-100 text-[12px] italic text-gray-400 leading-snug">
            These are your plan&rsquo;s stated rules — always confirm with your plan before scheduling.
          </p>
        </>
      )}
    </div>
  );
}

// ── Surface 1 — per-service detail (rendered inside an expanded service) ─────
export type EocServiceItem = Partial<ServiceCoverageDetail> & { priorAuthRequired?: boolean | null };

function SecLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] font-bold uppercase tracking-[0.08em] text-gray-400">{children}</div>;
}

/** Surface 1 — per-service prior-auth + medical-necessity detail + ONE consolidated proof disclosure. */
export function EocServiceCoverageDetail({ item, costQuote }: { item: EocServiceItem; costQuote?: string | null }) {
  const paCriteria = item.priorAuthAllCriteria && item.priorAuthAllCriteria.length > 0 ? item.priorAuthAllCriteria : item.priorAuthCriteria ? [item.priorAuthCriteria] : [];
  const mn = item.medicalNecessityCriteria ?? [];
  const hasPa = paCriteria.length > 0;
  const hasMn = !!(item.medicalNecessityText || mn.length > 0);
  const icd = item.diagnosisQualifiers ?? [];

  // ONE consolidated cite block (Cost / Prior auth / Medical necessity). Dedup
  // repeats and drop degenerate "quotes" (a bare service name like "Surgery").
  const rawQuotes: { label: string; text: string }[] = [];
  if (costQuote) rawQuotes.push({ label: "Cost", text: costQuote });
  if (item.priorAuthSourceExcerpt) rawQuotes.push({ label: "Prior authorization", text: item.priorAuthSourceExcerpt });
  for (const m of mn) if (m.excerpt) rawQuotes.push({ label: "Medical necessity", text: m.excerpt });
  const seenQuotes = new Set<string>();
  const quotes = rawQuotes.filter((q) => {
    const t = q.text.trim();
    if (!/\s/.test(t) || t.length < 10) return false; // degenerate (single word / fragment)
    const k = t.toLowerCase().replace(/\s+/g, " ");
    if (seenQuotes.has(k)) return false;
    seenQuotes.add(k);
    return true;
  });

  if (!hasPa && !hasMn && quotes.length === 0) return null;

  return (
    <div className="flex flex-col gap-6">
      {hasPa && (
        <div>
          <SecLabel>Prior authorization</SecLabel>
          <div className="mt-2.5 inline-flex items-center gap-1.5 text-[15px] font-semibold text-amber-700">
            <Svg d={ICON.warn} className="w-[15px] h-[15px]" sw={1.9} /> Required before this service.
          </div>
          {paCriteria.map((c, i) => (
            <p key={i} className="mt-2 text-[15px] text-gray-600 leading-relaxed">{c}</p>
          ))}
        </div>
      )}

      {hasMn && (
        <div>
          <SecLabel>Medical necessity</SecLabel>
          {item.medicalNecessityText && <p className="mt-2 text-[15px] text-gray-600 leading-relaxed">{item.medicalNecessityText}</p>}
          {mn.filter((m) => m.text && m.text !== item.medicalNecessityText).map((m, i) => (
            <p key={i} className="mt-2 text-[15px] text-gray-600 leading-relaxed">{m.text}</p>
          ))}
          {icd.length > 0 && (
            <>
              <div className="mt-3.5 text-[12px] text-gray-400">Applies to these diagnoses (ICD-10)</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {icd.map((c, i) => (
                  <span key={i} className="font-mono text-[11.5px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-md">{c}</span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <ProofDisclosure items={quotes} />
    </div>
  );
}

// ── Surface 3 — "Good to know" (collapsible card + collapsible sub-groups) ───
function KnowGroup({ group, open, onToggle }: { group: AboutGroup; open: boolean; onToggle: () => void }) {
  return (
    <div className="border-t border-gray-100 first:border-t-0">
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-2.5 py-4 text-left">
        <span className="flex-1 text-[14.5px] font-semibold text-gray-900">{group.label}</span>
        <span className="text-[12px] font-semibold text-gray-400">{group.items.length}</span>
        <Svg d={ICON.chevron} className={"w-[17px] h-[17px] text-gray-400 transition-transform " + (open ? "rotate-180" : "")} sw={2.2} />
      </button>
      {open && (
        <div className="pb-[18px] flex flex-col gap-3">
          {group.items.map((it, i) => (
            <div key={i} className="flex gap-2.5">
              <span className="mt-[7px] w-1 h-1 rounded-full bg-gray-300 shrink-0" />
              <p className="text-[14px] text-gray-600 leading-relaxed">{it.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function EocAboutPlanCard({ groups }: { groups: AboutGroup[] }) {
  const [open, setOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(groups[0]?.label ?? null);
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  if (count === 0) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-[20px] p-[22px] shadow-sm">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full flex items-center gap-3.5 text-left">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-blue-600">About your plan</div>
          <h3 className="mt-2 text-[17px] font-semibold text-gray-900 tracking-[-0.01em]">Good to know</h3>
        </div>
        <span className="inline-flex items-center gap-2 shrink-0 text-[13px] font-semibold text-gray-500 whitespace-nowrap">
          {count} details
          <Svg d={ICON.chevron} className={"w-[18px] h-[18px] text-gray-400 transition-transform " + (open ? "rotate-180" : "")} sw={2.2} />
        </span>
      </button>
      {open && (
        <div className="mt-4 pt-1 border-t border-gray-100">
          {groups.map((g) => (
            <KnowGroup key={g.label} group={g} open={openGroup === g.label} onToggle={() => setOpenGroup(openGroup === g.label ? null : g.label)} />
          ))}
        </div>
      )}
    </div>
  );
}

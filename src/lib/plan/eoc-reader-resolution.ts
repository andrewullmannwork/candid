// ============================================================================
// EOC reader-resolution (S202, block spec [[eoc_content_type_routing]] §9)
// ----------------------------------------------------------------------------
// Pure, DB-free resolver that turns the EOC facts already persisted on a user's
// plan (Flip-A E2E, S201) into the read-time surfaces /api/plan/analyze emits:
//   • one plan-level "Prior authorization" card, split Needs-approval / No-approval,
//     scope shown as chips (handoff-coverage-rules 3 "calm" design)
//   • "Good to know" / About-your-plan member info (collapsible sub-groups)
// Per-service (Surface 1) fields are extracted inline in the route from each
// cell's coverage_rules (helper `extractServiceCoverageDetail` below).
//
// Discipline: READ-ONLY (no DB writes, Pattern 1 #14). Honors the 3-case model.
// The verbatim quote is one tap away (consumer renders it behind a disclosure);
// only a 'verified' excerpt is surfaced as a quote (G tightens display later).
// ============================================================================

export type PaPolarity = "requires" | "waived";

/** One element of insurance_plans.metadata.eoc_prior_auth_facts[] (process-eoc buildPriorAuthFactRecord). */
export interface EocPriorAuthFact {
  service_slug: string | null;
  place_of_service: string | null;
  polarity: PaPolarity | null;
  routing_reason?: string;
  criteria_text: string;
  source_excerpt: string;
  source_excerpt_verified: string;
  type_confidence: number | null;
}

/** One element of insurance_plans.metadata.eoc_coverage_provisions[] (process-eoc buildAdminProvisionRecord). */
export interface EocCoverageProvision {
  service_slug: string | null;
  place_of_service: string | null;
  text: string;
  source_excerpt: string;
  source_excerpt_verified: string;
  type_confidence: number | null;
}

export interface ScopeChip {
  kind: "scope" | "exc";
  label: string;
}

export interface PaStatement {
  polarity: PaPolarity;
  scopeChips: ScopeChip[]; // [] = plan-wide (no chip); a scope chip for setting/service; + Exception when a carve-out
  text: string;
  quote: string | null; // source_excerpt when verified, else null
  quoteVerified: boolean;
}

export interface AboutItem {
  text: string;
  excerpt?: string;
  verified: boolean;
}

export interface AboutGroup {
  label: string;
  items: AboutItem[];
}

export interface EocReaderSurfaces {
  priorAuth: { requires: PaStatement[]; noApproval: PaStatement[] };
  aboutGroups: AboutGroup[];
}

export interface ListedService {
  slug: string;
  priorAuthRequired: boolean | null;
}

export interface ResolveEocReaderInput {
  metadata: Record<string, unknown> | null | undefined;
  /** Services with a coverage cell on this plan (for dedup + conservative suppress). */
  listedServices: ListedService[];
  /** slug -> human label (from service_catalog; falls back to a prettified slug). */
  serviceNameBySlug: (slug: string) => string;
}

// ── setting display normalization (EOC axis tokens AND the DB pos enum) ──────
const SETTING_LABEL: Record<string, string> = {
  inpatient: "Inpatient",
  inpatient_facility: "Inpatient",
  outpatient: "Outpatient",
  outpatient_facility: "Outpatient",
  independent_facility: "Outpatient",
  emergency: "Emergency",
  office: "Office",
  pcp_office: "Office",
  specialist_office: "Office",
  virtual: "Virtual",
  home: "Home",
  retail_pharmacy: "Pharmacy",
  home_delivery_pharmacy: "Pharmacy",
  designated_pharmacy: "Pharmacy",
};

function prettifySetting(pos: string): string {
  const key = pos.trim().toLowerCase();
  return SETTING_LABEL[key] ?? titleCase(pos);
}

function titleCase(s: string): string {
  return s.replace(/_/g, " ").trim().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function prettifySlug(slug: string): string {
  const words = slug.replace(/_/g, " ").trim().replace(/\s+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function isPaPolarity(v: unknown): v is PaPolarity {
  return v === "requires" || v === "waived";
}

function asFacts(metadata: Record<string, unknown> | null | undefined): EocPriorAuthFact[] {
  const raw = metadata?.eoc_prior_auth_facts;
  return Array.isArray(raw) ? (raw as EocPriorAuthFact[]) : [];
}

function asProvisions(metadata: Record<string, unknown> | null | undefined): EocCoverageProvision[] {
  const raw = metadata?.eoc_coverage_provisions;
  return Array.isArray(raw) ? (raw as EocCoverageProvision[]) : [];
}

// breadth: plan-wide (no chip) → setting chip → service chip. Broadest first.
function breadth(s: PaStatement): number {
  if (s.scopeChips.length === 0) return 0;
  return s.scopeChips.some((c) => c.kind === "scope" && /^(Inpatient|Outpatient|Emergency|Office|Virtual|Home|Pharmacy)$/.test(c.label)) ? 1 : 2;
}
function stmtSort(a: PaStatement, b: PaStatement): number {
  const d = breadth(a) - breadth(b);
  // Deterministic tiebreaker so the output is order-independent (facts arrive in
  // nondeterministic chunk order) — the "unordered-safe" §9 principle.
  return d !== 0 ? d : a.text.localeCompare(b.text);
}

/**
 * Resolve the single plan-level prior-auth card (split by polarity) + About groups.
 * Treats the facts array as UNORDERED (dedup -> classify -> sort for display).
 */
export function resolveEocReaderSurfaces(input: ResolveEocReaderInput): EocReaderSurfaces {
  const { metadata, listedServices, serviceNameBySlug } = input;
  const listedSlugs = new Set(listedServices.map((s) => s.slug));

  // 1. Keep only spillover statements: a real requires/waived polarity, and NOT
  //    about a listed service (those show inline; a waiver contradicting a listed
  //    prior_auth_required is conservatively suppressed everywhere).
  const spillover = asFacts(metadata).filter(
    (f) => isPaPolarity(f.polarity) && !(f.service_slug && listedSlugs.has(f.service_slug)),
  );

  // 2. Dedup by (polarity, scope, normalized text).
  const seen = new Set<string>();
  const deduped: EocPriorAuthFact[] = [];
  for (const f of spillover) {
    const key = `${f.polarity}::${f.service_slug ?? ""}|${f.place_of_service ?? ""}::${norm(f.criteria_text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  // 3. Settings that carry a requirement — a waiver in one of these is an Exception (a carve-out).
  const requiresSettings = new Set(
    deduped.filter((f) => f.polarity === "requires" && f.place_of_service).map((f) => prettifySetting(f.place_of_service as string)),
  );

  const toStatement = (f: EocPriorAuthFact): PaStatement => {
    const chips: ScopeChip[] = [];
    if (f.service_slug) chips.push({ kind: "scope", label: serviceNameBySlug(f.service_slug) });
    else if (f.place_of_service) chips.push({ kind: "scope", label: prettifySetting(f.place_of_service) });
    const isException = f.polarity === "waived" && !!f.place_of_service && requiresSettings.has(prettifySetting(f.place_of_service));
    if (isException) chips.push({ kind: "exc", label: "Exception" });
    const verified = f.source_excerpt_verified === "verified";
    return { polarity: f.polarity as PaPolarity, scopeChips: chips, text: f.criteria_text, quote: verified ? f.source_excerpt : null, quoteVerified: verified };
  };

  const requires = deduped.filter((f) => f.polarity === "requires").map(toStatement).sort(stmtSort);
  const noApproval = deduped.filter((f) => f.polarity === "waived").map(toStatement).sort(stmtSort);

  return { priorAuth: { requires, noApproval }, aboutGroups: groupProvisions(asProvisions(metadata)) };
}

// ── About-your-plan theming (low-stakes; coarse + universal, General fallback) ─
const ABOUT_THEMES: { label: string; re: RegExp }[] = [
  { label: "Getting care", re: /appointment|business day|nurse|advice line|urgent care|referral|wait|schedul|access to care|telehealth/i },
  { label: "Member services", re: /interpreter|language|customer service|bluecard|out of state|away from home|id card|website|portal|phone/i },
];

function themeProvision(text: string): string {
  for (const t of ABOUT_THEMES) if (t.re.test(text)) return t.label;
  return "Plan details";
}

function groupProvisions(provisions: EocCoverageProvision[]): AboutGroup[] {
  const seen = new Set<string>();
  const items: { text: string; theme: string; excerpt?: string; verified: boolean }[] = [];
  for (const p of provisions) {
    const text = (p.text ?? "").trim();
    if (!text) continue;
    const k = norm(text);
    if (seen.has(k)) continue;
    seen.add(k);
    const verified = p.source_excerpt_verified === "verified";
    items.push({ text, theme: themeProvision(text), excerpt: verified ? p.source_excerpt : undefined, verified });
  }
  if (items.length === 0) return [];

  const order = ["Getting care", "Member services", "Plan details"];
  const byTheme = new Map<string, AboutItem[]>();
  for (const it of items) {
    (byTheme.get(it.theme) ?? byTheme.set(it.theme, []).get(it.theme)!).push({ text: it.text, excerpt: it.excerpt, verified: it.verified });
  }
  if (byTheme.size <= 1) {
    return [{ label: "General", items: items.map((it) => ({ text: it.text, excerpt: it.excerpt, verified: it.verified })) }];
  }
  return [...byTheme.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([label, groupItems]) => ({ label, items: groupItems }));
}

// ── Surface 1: per-service detail extracted from a cell's coverage_rules ─────
export interface ServiceCoverageDetail {
  priorAuthCriteria: string | null;
  priorAuthAllCriteria: string[];
  priorAuthSourceExcerpt: string | null;
  priorAuthSourceExcerptVerified: boolean;
  medicalNecessityText: string | null;
  medicalNecessityCriteria: { text: string; diagnosisQualifiers: string[]; excerpt: string | null; verified: boolean }[];
  diagnosisQualifiers: string[];
}

/**
 * Pull per-service prior-auth + medical-necessity detail out of a
 * plan_covered_services.coverage_rules JSONB blob. Returns null when the cell
 * carries no EOC-extracted clinical detail (the overwhelming, non-EOC case).
 */
export function extractServiceCoverageDetail(coverageRules: unknown): ServiceCoverageDetail | null {
  if (!coverageRules || typeof coverageRules !== "object") return null;
  const cr = coverageRules as Record<string, unknown>;

  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

  const mnRaw = Array.isArray(cr.medical_necessity_criteria) ? (cr.medical_necessity_criteria as Record<string, unknown>[]) : [];
  const medicalNecessityCriteria = mnRaw
    .map((m) => ({
      text: str(m.criteria_text) ?? "",
      diagnosisQualifiers: strArr(m.diagnosis_qualifiers),
      excerpt: m.source_excerpt_verified === "verified" ? str(m.source_excerpt) : null,
      verified: m.source_excerpt_verified === "verified",
    }))
    .filter((m) => m.text);

  const detail: ServiceCoverageDetail = {
    priorAuthCriteria: str(cr.prior_auth_criteria),
    priorAuthAllCriteria: strArr(cr.prior_auth_all_criteria),
    priorAuthSourceExcerpt: cr.prior_auth_source_excerpt_verified === "verified" ? str(cr.prior_auth_source_excerpt) : null,
    priorAuthSourceExcerptVerified: cr.prior_auth_source_excerpt_verified === "verified",
    medicalNecessityText: str(cr.medical_necessity_text),
    medicalNecessityCriteria,
    diagnosisQualifiers: strArr(cr.diagnosis_qualifiers),
  };

  const empty =
    !detail.priorAuthCriteria &&
    detail.priorAuthAllCriteria.length === 0 &&
    !detail.medicalNecessityText &&
    detail.medicalNecessityCriteria.length === 0 &&
    detail.diagnosisQualifiers.length === 0;
  return empty ? null : detail;
}

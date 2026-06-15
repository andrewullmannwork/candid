// ============================================================================
// EOC reader-resolution (S202, block spec [[eoc_content_type_routing]] §9)
// ----------------------------------------------------------------------------
// Pure, DB-free resolver that turns the EOC facts already persisted on a user's
// plan (Flip-A E2E, S201) into the read-time surfaces /api/plan/analyze emits:
//   • plan-level "Prior authorization · plan-wide"   (no setting, not a listed service)
//   • plan-level "Prior authorization · by location" (carries a care setting)
//   • "Good to know" / About-your-plan member info
// Per-service (Surface 1) fields are extracted inline in the route from each
// cell's coverage_rules (helper `extractServiceCoverageDetail` below).
//
// Discipline: READ-ONLY (no DB writes, Pattern 1 #14). Honors the 3-case model —
// these surfaces appear for the user's own plan rows whether the plan is active,
// switched, or a Case-3 inactive capture. The verbatim quote is the hero; only a
// 'verified' excerpt earns the green treatment (G tightens display later).
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
  kind: "plan" | "scope";
  label: string;
}

export interface PaStatement {
  polarity: PaPolarity;
  scopeChips: ScopeChip[];
  text: string;
  /** source_excerpt when verified, else null (unverified criteria show as plain prose). */
  quote: string | null;
  quoteVerified: boolean;
  /** true = a waiver that carves an exception out of a requirement in the same scope. */
  isException: boolean;
}

export interface ByLocationGroup {
  setting: string;
  statements: PaStatement[];
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
  planWidePA: PaStatement[];
  byLocationPA: ByLocationGroup[];
  aboutGroups: AboutGroup[];
}

export interface ListedService {
  slug: string;
  priorAuthRequired: boolean | null;
}

export interface ResolveEocReaderInput {
  metadata: Record<string, unknown> | null | undefined;
  /** The services that have a coverage cell on this plan (for dedup + conservative suppress). */
  listedServices: ListedService[];
  /** slug -> human label (loaded from service_catalog; falls back to a prettified slug). */
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
const SETTING_ORDER = ["Inpatient", "Outpatient", "Emergency", "Office", "Virtual", "Home", "Pharmacy"];

function prettifySetting(pos: string): string {
  const key = pos.trim().toLowerCase();
  return SETTING_LABEL[key] ?? titleCase(pos);
}

function titleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function prettifySlug(slug: string): string {
  // Sentence-case a slug as a last-resort label (off-catalog facts).
  const words = slug.replace(/_/g, " ").trim().replace(/\s+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// ── statement ordering: requirements before exceptions; broad before specific ──
function stmtSort(a: PaStatement, b: PaStatement): number {
  if (a.polarity !== b.polarity) return a.polarity === "requires" ? -1 : 1;
  const aSvc = a.scopeChips.some((c) => c.kind === "scope") ? 1 : 0;
  const bSvc = b.scopeChips.some((c) => c.kind === "scope") ? 1 : 0;
  return aSvc - bSvc;
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

/**
 * Resolve the two plan-level prior-auth aggregate cards + the About groups.
 * Treats the facts array as UNORDERED (dedup -> group -> sort for display).
 */
export function resolveEocReaderSurfaces(input: ResolveEocReaderInput): EocReaderSurfaces {
  const { metadata, listedServices, serviceNameBySlug } = input;
  const listedSlugs = new Set(listedServices.map((s) => s.slug));

  // 1. Keep only spillover statements: a real requires/waived polarity, and NOT
  //    about a listed service (those are shown inline on the service card; a
  //    waiver contradicting a listed `prior_auth_required` is conservatively
  //    suppressed everywhere — we never nudge a member to skip a precert).
  const spillover = asFacts(metadata).filter(
    (f) => isPaPolarity(f.polarity) && !(f.service_slug && listedSlugs.has(f.service_slug)),
  );

  // 2. Dedup by (polarity, scope, normalized text) — multiple chunks re-extract
  //    the same statement.
  const seen = new Set<string>();
  const deduped: EocPriorAuthFact[] = [];
  for (const f of spillover) {
    const key = `${f.polarity}::${f.service_slug ?? ""}|${f.place_of_service ?? ""}::${norm(f.criteria_text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  // 3. Split plan-wide (no setting) vs by-location (carries a setting) — this is
  //    where single-service-no-card facts land "most closely applicable".
  const planWideFacts = deduped.filter((f) => !f.place_of_service);
  const byLocFacts = deduped.filter((f) => !!f.place_of_service);

  // 4. Plan-wide card.
  const planWideHasRequires = planWideFacts.some((f) => f.polarity === "requires");
  const planWidePA = planWideFacts
    .map((f) => toStatement(f, planWideHasRequires, "plan", serviceNameBySlug))
    .sort(stmtSort);

  // 5. By-location card, grouped by setting.
  const groups = new Map<string, EocPriorAuthFact[]>();
  for (const f of byLocFacts) {
    const label = prettifySetting(f.place_of_service as string);
    (groups.get(label) ?? groups.set(label, []).get(label)!).push(f);
  }
  const byLocationPA: ByLocationGroup[] = [...groups.entries()]
    .sort((a, b) => settingRank(a[0]) - settingRank(b[0]))
    .map(([setting, fs]) => {
      const hasRequires = fs.some((f) => f.polarity === "requires");
      return {
        setting,
        statements: fs.map((f) => toStatement(f, hasRequires, "byloc", serviceNameBySlug)).sort(stmtSort),
      };
    });

  // 6. About-your-plan member info.
  const aboutGroups = groupProvisions(asProvisions(metadata));

  return { planWidePA, byLocationPA, aboutGroups };
}

function settingRank(label: string): number {
  const i = SETTING_ORDER.indexOf(label);
  return i === -1 ? SETTING_ORDER.length : i;
}

function toStatement(
  f: EocPriorAuthFact,
  groupHasRequires: boolean,
  cardKind: "plan" | "byloc",
  serviceNameBySlug: (slug: string) => string,
): PaStatement {
  const scopeChips: ScopeChip[] = [];
  if (f.service_slug) {
    scopeChips.push({ kind: "scope", label: serviceNameBySlug(f.service_slug) });
  } else if (cardKind === "plan") {
    // True plan-wide (no service, no setting) — label it so the row isn't bare.
    scopeChips.push({ kind: "plan", label: "Plan-wide" });
  }
  // In the by-location card the setting IS the group header, so a slug-less axis
  // fact needs no chip; a slug-bearing fact keeps its service chip (added above).

  const verified = f.source_excerpt_verified === "verified";
  return {
    polarity: f.polarity as PaPolarity,
    scopeChips,
    text: f.criteria_text,
    quote: verified ? f.source_excerpt : null,
    quoteVerified: verified,
    isException: f.polarity === "waived" && groupHasRequires,
  };
}

// ── About-your-plan theming (low-stakes; coarse + universal, General fallback) ─
const ABOUT_THEMES: { label: string; re: RegExp }[] = [
  { label: "Getting care", re: /appointment|business day|nurse|advice line|urgent care|referral|wait|schedul|access to care/i },
  { label: "Member services", re: /interpreter|language|customer service|bluecard|out of state|away from home|id card|website|portal|phone/i },
];

function themeProvision(text: string): string {
  for (const t of ABOUT_THEMES) if (t.re.test(text)) return t.label;
  return "Plan details";
}

function groupProvisions(provisions: EocCoverageProvision[]): AboutGroup[] {
  // Dedup by normalized text, then theme. Degrade to a single "General" group if
  // everything would land in one bucket (keeps it from looking artificially split).
  const seen = new Set<string>();
  const items: { text: string; theme: string; excerpt?: string; verified: boolean }[] = [];
  for (const p of provisions) {
    const text = (p.text ?? "").trim();
    if (!text) continue;
    const k = norm(text);
    if (seen.has(k)) continue;
    seen.add(k);
    const verified = p.source_excerpt_verified === "verified";
    items.push({
      text,
      theme: themeProvision(text),
      excerpt: verified ? p.source_excerpt : undefined,
      verified,
    });
  }
  if (items.length === 0) return [];

  const order = ["Getting care", "Member services", "Plan details"];
  const byTheme = new Map<string, AboutItem[]>();
  for (const it of items) {
    (byTheme.get(it.theme) ?? byTheme.set(it.theme, []).get(it.theme)!).push({
      text: it.text,
      excerpt: it.excerpt,
      verified: it.verified,
    });
  }
  // Single populated theme -> collapse to "General" (the universal-safe fallback).
  if (byTheme.size <= 1) {
    return [{ label: "General", items: items.map((it) => ({ text: it.text, excerpt: it.excerpt, verified: it.verified })) }];
  }
  return [...byTheme.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([label, groupItems]) => ({ label, items: groupItems }));
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
 * Pull the per-service prior-auth + medical-necessity detail out of a
 * plan_covered_services.coverage_rules JSONB blob. Returns null when the cell
 * carries no EOC-extracted clinical detail (the overwhelming, non-EOC case) so
 * the route can omit the fields entirely.
 */
export function extractServiceCoverageDetail(coverageRules: unknown): ServiceCoverageDetail | null {
  if (!coverageRules || typeof coverageRules !== "object") return null;
  const cr = coverageRules as Record<string, unknown>;

  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

  const priorAuthCriteria = str(cr.prior_auth_criteria);
  const priorAuthAllCriteria = strArr(cr.prior_auth_all_criteria);
  const medicalNecessityText = str(cr.medical_necessity_text);

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
    priorAuthCriteria,
    priorAuthAllCriteria,
    priorAuthSourceExcerpt: cr.prior_auth_source_excerpt_verified === "verified" ? str(cr.prior_auth_source_excerpt) : null,
    priorAuthSourceExcerptVerified: cr.prior_auth_source_excerpt_verified === "verified",
    medicalNecessityText,
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

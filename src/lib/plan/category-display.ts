/**
 * Category display maps + label resolution shared by /plan and /dashboard
 * (S289 — extracted from page-local copies so the fixture can assert them and
 * so the two pages can't drift).
 *
 * Two vocabularies feed these maps:
 *   - V1 = service_catalog.category (the live DB taxonomy; 19-value CHECK,
 *     mig 148) — what user-row and canonical benefits carry.
 *   - V2 = BenefitCategory (src/lib/plan/benefits-catalog.ts) — the static
 *     educational catalog; the only DB-independent analyze path
 *     (dataSource "static_catalog") plus admin-pipeline plan_benefits rows.
 *
 * labelForCategory resolves V1-first (live taxonomy wins), EXCEPT on the
 * static_catalog path where V2 authored the grouping (its "maternity" bucket
 * genuinely includes family-planning content, so V2's broader label is the
 * accurate one there).
 */

import type { TileDomain } from "@/components/dashboard/BenefitsGrid";
import { BENEFIT_CATEGORY_LABELS, type BenefitCategory } from "@/lib/plan/benefits-catalog";

/** V1 (service_catalog.category) → display label. Covers all 19 CHECK values + "general". */
export const SERVICE_CATEGORY_LABELS: Record<string, string> = {
  office_visit: "Office Visits",
  emergency: "Emergency",
  hospital: "Hospital",
  imaging: "Imaging",
  lab: "Lab & Testing",
  rx: "Prescriptions",
  therapy: "Therapy & Rehab",
  mental_health: "Mental Health",
  maternity: "Maternity",
  dme: "Equipment & Supplies",
  preventive: "Preventive Care",
  long_term_care: "Long-Term Care",
  // S289 — previously unlabeled (fell through to auto title-case, gray icon):
  dental: "Dental",
  vision: "Vision",
  surgery: "Surgery",
  hospitalization: "Hospital Stays",
  dialysis: "Dialysis",
  family_planning: "Family Planning",
  other: "Other Services",
  general: "General",
};

/**
 * Display label for a benefit-category slug.
 *
 * Precedence: V1 (live taxonomy) → V2 (static catalog) → auto title-case.
 * On dataSource "static_catalog" the order flips V2-first — that path's
 * groupings were authored in V2 and its labels are the accurate ones there
 * (the only overlapping keys are maternity + mental_health; mental_health is
 * identical in both).
 */
export function labelForCategory(category: string, dataSource?: string): string {
  const v1 = SERVICE_CATEGORY_LABELS[category];
  const v2 = BENEFIT_CATEGORY_LABELS[category as BenefitCategory];
  const auto = category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (dataSource === "static_catalog") return v2 || v1 || auto;
  return v1 || v2 || auto;
}

/** Map candid category strings (BenefitCategory or service_catalog) → design tile domain. */
export function categoryToDomain(category: string): TileDomain {
  const map: Record<string, TileDomain> = {
    // BenefitCategory enum values (benefits-catalog.ts)
    preventive_care: "preventive",
    mental_health: "mental",
    nutrition: "other",
    physical_therapy: "therapy",
    hsa_fsa: "other",
    telehealth: "office",
    chronic_care: "ltc",
    wellness: "preventive",
    maternity: "maternity",
    vision_dental: "other",
    // Service catalog category values
    imaging: "imaging",
    emergency: "emergency",
    office_visit: "office",
    hospital: "hospital",
    lab: "lab",
    rx: "rx",
    therapy: "therapy",
    dme: "equip",
    preventive: "preventive",
    other: "other",
    general: "other",
    // S289 — previously missing (all fell to "other"; LTC tile could never count):
    long_term_care: "ltc",
    hospitalization: "hospital",
    surgery: "hospital",
    dialysis: "ltc", // precedent: chronic_care→ltc; recurring facility care
    family_planning: "maternity", // tile is literally "Maternity & Family"
    dental: "other", // no dental/vision tiles exist — adding tiles is a product decision
    vision: "other",
  };
  return map[category] ?? "other";
}

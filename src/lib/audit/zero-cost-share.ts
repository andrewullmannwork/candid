// S74.5 D13 — Zero-cost-share registry audit stage.
//
// Per plans/s74.5_categorization_flywheel.md v2 §7.1 + Q-A/B/C/K LOCK.
//
// Runs BEFORE the plan-coverage check. For each line item, looks up
// zero_cost_share_codes (ACA preventive + ACIP vaccine) by (billing_code,
// billing_code_type). On hit + patient_responsibility > 0 → flag overcharge
// finding type "zero_cost_share_overcharge" with source_url for dispute
// evidence citation.
//
// S74.5c §2.2 — demographic eligibility filter wired. We fetch the user's
// date_of_birth + sex from profiles (already collected at signup; see mig
// 0041_profile_demographics.sql) and skip findings whose row's age_min /
// age_max / sex don't match. When profile data is missing we fall back to
// the v1 "fire-and-let-user-dismiss" behavior — better to over-surface a
// dismissable finding than to silently miss one.

import { createServerClient } from "../supabase/server";
import { isFeatureEnabled } from "../config/product-flags";
import type { ParsedBill, AuditFinding, BillLineItem } from "../billing/types";
import { inferProcedureCodeType } from "../billing/code-type-inference";
import { randomUUID } from "crypto";

export interface UserDemographics {
  age: number | null;
  sex: "M" | "F" | null;
}

interface DependentRecord {
  name?: string;
  date_of_birth?: string;
  sex?: string;
  relationship?: string;
  on_same_plan?: boolean;
}

function normalizeName(name: string | undefined | null): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[.,'"()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// S74.5c C-4 — calendar-age computation. Server runs in UTC; we use UTC date
// parts for year/month/day extraction so the answer is consistent regardless
// of the requester's local timezone. Users near midnight in non-UTC zones may
// see their age compute as +1 day older than their wallclock for a few hours
// — for ACA coverage eligibility (age windows like 21-65) that 1-day drift
// is immaterial.
function computeAgeFromDOB(dobString: string | null | undefined): number | null {
  if (!dobString) return null;
  const dobMs = Date.parse(dobString);
  if (!Number.isFinite(dobMs)) return null;
  const now = new Date();
  const birth = new Date(dobMs);
  let years = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - birth.getUTCMonth();
  const beforeBirthday =
    monthDelta < 0 ||
    (monthDelta === 0 && now.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) years -= 1;
  if (Number.isFinite(years) && years >= 0 && years < 130) return years;
  return null;
}

function mapSexToMF(sexRaw: string | null | undefined): "M" | "F" | null {
  // profiles.sex enum is 'male' | 'female' | 'prefer_not_to_say'; the
  // zero_cost_share_codes.sex column uses 'M' | 'F'.
  if (sexRaw === "male") return "M";
  if (sexRaw === "female") return "F";
  return null;
}

// S74.5c C-1 — resolve demographics for the PATIENT on the bill, not just
// the bill UPLOADER. If the patient name matches a profile.dependents entry,
// use that dependent's DOB + sex. Falls back to the user's own profile when
// the patient is the account holder or no dependent match exists.
//
// Why this matters: a parent uploading a child's pediatric vaccine bill
// wouldn't want the adult-eligibility-window filter to suppress findings.
// And conversely, a male user uploading his daughter's HPV-vaccine bill
// should see the ACA preventive finding fire under the daughter's sex.
export async function fetchPatientDemographics(
  userId: string,
  patientNameFromBill: string | null | undefined,
): Promise<UserDemographics> {
  if (!userId) return { age: null, sex: null };
  const supabase = createServerClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("date_of_birth, sex, display_name, dependents")
    .eq("user_id", userId)
    .maybeSingle();
  if (!profile) return { age: null, sex: null };

  const billPatient = normalizeName(patientNameFromBill);
  const accountHolder = normalizeName(profile.display_name as string | null);

  // No bill-side patient name OR matches the account holder → use account demographics.
  if (!billPatient || (accountHolder && billPatient === accountHolder)) {
    return {
      age: computeAgeFromDOB(profile.date_of_birth as string | null),
      sex: mapSexToMF(profile.sex as string | null),
    };
  }

  // Search dependents for a name match. Pattern 1 #14 storage discipline:
  // dependents JSONB is user-scoped; we only read this user's array.
  const dependents = (profile.dependents as DependentRecord[] | null) ?? [];
  const matchingDependent = dependents.find(
    (d) => normalizeName(d.name) === billPatient,
  );
  if (matchingDependent) {
    return {
      age: computeAgeFromDOB(matchingDependent.date_of_birth),
      sex: mapSexToMF(matchingDependent.sex),
    };
  }

  // No match — patient on the bill is neither the account holder nor a
  // listed dependent. Could be a misspelling, a recently-added dependent
  // not yet entered, or a billed-under-a-friend's-account scenario. Fall
  // back to user's demographics + accept some false-positives (user can
  // dismiss via D15 with reason='other').
  return {
    age: computeAgeFromDOB(profile.date_of_birth as string | null),
    sex: mapSexToMF(profile.sex as string | null),
  };
}

export function demographicEligible(
  row: { age_min: number | null; age_max: number | null; sex: "M" | "F" | null },
  user: UserDemographics,
): boolean {
  // Row's filter narrows; if the row has no constraint (null), every user
  // matches. If the user has no profile data (null), we can't disprove
  // eligibility → fall through to the v1 fire behavior.
  if (row.age_min != null && user.age != null && user.age < row.age_min) return false;
  if (row.age_max != null && user.age != null && user.age > row.age_max) return false;
  if (row.sex != null && user.sex != null && row.sex !== user.sex) return false;
  return true;
}

interface ZeroCostShareRow {
  id: string;
  billing_code: string;
  billing_code_type: string;
  coverage_basis: "ACA_preventive" | "ACIP_vaccine";
  category: string | null;
  uspstf_grade: "A" | "B" | null;
  age_min: number | null;
  age_max: number | null;
  sex: "M" | "F" | null;
  frequency_limit: string | null;
  source_url: string;
  source_label: string;
  display_name: string;
}

export async function runZeroCostShareCheck(
  bill: ParsedBill,
): Promise<AuditFinding[]> {
  const flagOn = await isFeatureEnabled("s74_5_categorization_flywheel_v1");
  if (!flagOn) return [];

  const eligibleLines = bill.lineItems.filter(
    (li) => li.procedureCode && (li.patientResponsibility ?? 0) > 0.5,
  );
  if (eligibleLines.length === 0) return [];

  const supabase = createServerClient();
  const findings: AuditFinding[] = [];

  // Build lookup keys per line — pair (code, codeType) where codeType uses our
  // ProcedureCodeType namespace (inferred via D0 helper if upstream omitted).
  const lookupKeys = eligibleLines.map((li) => {
    const code = li.procedureCode;
    const codeType = li.procedureCodeType ?? inferProcedureCodeType(code);
    return { lineNumber: li.lineNumber, code, codeType, item: li };
  });

  const codeTypeNamespaceWhitelist = new Set([
    "CPT",
    "HCPCS_L2",
    "G_CODE",
    "CAT_II",
  ]);

  const distinctCodes = Array.from(
    new Set(
      lookupKeys
        .filter((k) => k.codeType && codeTypeNamespaceWhitelist.has(k.codeType))
        .map((k) => `${k.code}|${k.codeType}`),
    ),
  );
  if (distinctCodes.length === 0) return [];

  // Single OR-style query — Supabase doesn't natively support tuple IN,
  // so we issue one query per (code, codeType) using .in on code with
  // post-filter on codeType. Small volume per bill (<10 codes); acceptable.
  // Order by coverage_basis ascending so when a code appears under both
  // ACA_preventive + ACIP_vaccine, the ACA row sorts first deterministically
  // (matchingRows[0] below). Stable for snapshot tests + dispute citations.
  const { data: rows, error } = await supabase
    .from("zero_cost_share_codes")
    .select(
      "id, billing_code, billing_code_type, coverage_basis, category, uspstf_grade, age_min, age_max, sex, frequency_limit, source_url, source_label, display_name",
    )
    .in(
      "billing_code",
      lookupKeys.map((k) => k.code),
    )
    .is("retired_at", null)
    .order("coverage_basis", { ascending: true });

  if (error) {
    console.warn("[zero-cost-share] lookup failed", error);
    return [];
  }
  if (!rows || rows.length === 0) return [];

  const rowsTyped = rows as ZeroCostShareRow[];

  // §2.2 + C-1 — fetch PATIENT demographics once per audit run. Resolves
  // against profile.dependents when bill.patient.name doesn't match the
  // account holder. Falls back to user's own demographics for unrecognized
  // patient names; demographicEligible() treats null as "can't disprove →
  // eligible" so we don't regress v1 behavior.
  const demographics = await fetchPatientDemographics(
    bill.userId,
    bill.patient?.name ?? null,
  );

  for (const k of lookupKeys) {
    if (!k.codeType) continue;
    const matchingRows = rowsTyped.filter(
      (r) =>
        r.billing_code === k.code &&
        r.billing_code_type === k.codeType &&
        demographicEligible(
          {
            age_min: r.age_min,
            age_max: r.age_max,
            sex: r.sex,
          },
          demographics,
        ),
    );
    if (matchingRows.length === 0) continue;

    // Prefer the most specific row (oldest first, ACA preventive before ACIP if both match)
    const row = matchingRows[0];
    findings.push(buildFinding(k.item, row));
  }

  return findings;
}

function buildFinding(item: BillLineItem, row: ZeroCostShareRow): AuditFinding {
  const charged = item.patientResponsibility ?? 0;
  const basisLabel =
    row.coverage_basis === "ACA_preventive"
      ? "ACA-mandated preventive service"
      : "ACIP-recommended vaccine";

  const eligibilityNote = formatEligibilityNote(row);

  return {
    id: randomUUID(),
    type: "zero_cost_share_overcharge",
    severity: charged >= 100 ? "high" : charged >= 25 ? "medium" : "low",
    lineItems: [item.lineNumber],
    title: `Likely $0 service — ${row.display_name}`,
    description: `You were charged $${charged.toFixed(
      2,
    )} for this service. Under federal law (${basisLabel}), ACA-compliant plans must cover this at $0 patient cost-share when delivered in-network.${
      eligibilityNote ? " " + eligibilityNote : ""
    } Source: ${row.source_label}.`,
    estimatedOvercharge: charged,
    benchmarkSource: row.source_url,
    benchmarkAmount: 0,
    billedAmount: item.billedAmount,
    confidence: 0.85,
    actionable: true,
  };
}

function formatEligibilityNote(row: ZeroCostShareRow): string {
  const parts: string[] = [];
  if (row.age_min != null && row.age_max != null) {
    parts.push(`Age ${row.age_min}-${row.age_max}`);
  } else if (row.age_min != null) {
    parts.push(`Age ${row.age_min}+`);
  } else if (row.age_max != null) {
    parts.push(`Age 0-${row.age_max}`);
  }
  if (row.sex) {
    parts.push(row.sex === "F" ? "biological females" : "biological males");
  }
  if (row.frequency_limit) {
    parts.push(`limit: ${row.frequency_limit}`);
  }
  if (parts.length === 0) return "";
  return `Eligibility: ${parts.join("; ")}.`;
}

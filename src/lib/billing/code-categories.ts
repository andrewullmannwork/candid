// Client-safe legacy category lookup for billing codes.
//
// S74.5c §2.3 — extracted from parser.ts so ClaimDetail.tsx (client component)
// can surface a "<category> — review needed" hint per Subplan §5 when the
// categorization flywheel hasn't resolved a service_slug yet. parser.ts pulls
// `crypto.randomUUID`, which Next.js refuses to bundle for client code; this
// module has no such dependency.
//
// Keep in sync with parser.ts CPT_CATEGORIES — that file re-exports
// categorizeProcedureCode from here.

const CPT_CATEGORIES: Record<string, string> = {
  "992": "Office/Outpatient Visit",
  "993": "Preventive Visit",
  "994": "Consultation",
  "995": "Emergency Department",
  "996": "Critical Care",
  "997": "Inpatient Procedures",
  "700": "Radiology — Diagnostic",
  "710": "Radiology — Radiation Therapy",
  "712": "Radiology — Nuclear Medicine",
  "800": "Pathology/Lab",
  "810": "Pathology/Lab",
  "820": "Pathology/Lab",
  "830": "Pathology/Lab",
  "840": "Pathology/Lab",
  "850": "Pathology/Lab",
  "860": "Pathology/Lab",
  "870": "Pathology/Lab",
  "880": "Pathology/Lab",
  "890": "Pathology/Lab",
  "100": "Surgery — Integumentary",
  "200": "Surgery — Musculoskeletal",
  "300": "Surgery — Respiratory/Cardiovascular",
  "400": "Surgery — Digestive",
  "500": "Surgery — Urinary/Reproductive",
  "600": "Surgery — Nervous System/Eye/Ear",
  "904": "Immunization Administration",
  "905": "Vaccine",
  "906": "Vaccine",
  "907": "Vaccine",
  "913": "Vaccine — COVID-19",
  "900": "Medicine — Misc",
  "960": "Anesthesia",
  "A00": "Transport/DME",
  "J00": "Drug Administration",
  "L00": "Orthotics/Prosthetics",
};

export function categorizeProcedureCode(code: string): string {
  const normalized = code.toUpperCase();

  if (/^\d{4}F$/.test(normalized)) {
    return "Quality Reporting (Cat II)";
  }
  if (/^G\d{4}$/.test(normalized)) {
    return "Medicare Service";
  }

  const prefix3 = normalized.substring(0, 3);
  if (CPT_CATEGORIES[prefix3]) return CPT_CATEGORIES[prefix3];

  const prefix2 = normalized.substring(0, 2) + "0";
  if (CPT_CATEGORIES[prefix2]) return CPT_CATEGORIES[prefix2];

  const prefix1 = normalized.substring(0, 1) + "00";
  if (CPT_CATEGORIES[prefix1]) return CPT_CATEGORIES[prefix1];

  return "Medical Service";
}

// Subplan §5 — surface a "review needed" hint when the flywheel hasn't yet
// resolved a service_slug for this code. Pure function for client-side use.
export function legacyCategoryReviewHint(code: string): string {
  return `${categorizeProcedureCode(code)} — review needed`;
}

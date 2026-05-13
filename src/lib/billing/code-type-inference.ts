// Procedure-code-type inference from format alone.
//
// S74.5 D0 — guarantees billing_code_identity composite-key robustness
// against null code_types from either (a) legacy regex parser, which doesn't
// emit procedureCodeType, or (b) Haiku omissions on the higher-fidelity path.
//
// Rules mirror haiku-bill-parser.ts INSTRUCTIONS Rule #12 so both paths agree.

import type { ProcedureCodeType } from "./types";

export function inferProcedureCodeType(rawCode: string): ProcedureCodeType | undefined {
  const code = rawCode.trim().toUpperCase();
  if (!code) return undefined;

  // CPT Category II — 4-digit + 'F' (e.g., 3074F, 0521F). $0 quality-reporting.
  if (/^\d{4}F$/.test(code)) return "CAT_II";

  // HCPCS Level II G-codes — G + 4 digits (e.g., G0008, G8510). Medicare admin.
  if (/^G\d{4}$/.test(code)) return "G_CODE";

  // HCPCS Level II generic — single letter + 4 digits, excluding G (handled above).
  if (/^[A-FH-Z]\d{4}$/.test(code)) return "HCPCS_L2";

  // Revenue codes — 4-digit numeric typically starting with 0 (e.g., 0301, 0450).
  // Must check before generic 4-digit to avoid DRG misclassification.
  if (/^0\d{3}$/.test(code)) return "REV";

  // NDC — 11-digit numeric (drug codes; 10-digit forms normalized to 11 upstream).
  if (/^\d{11}$/.test(code)) return "NDC";

  // CPT — 5-digit numeric (most common path).
  if (/^\d{5}$/.test(code)) return "CPT";

  // DRG — 3-digit numeric. Rare on consumer bills; usually in DRG-context tables.
  if (/^\d{3}$/.test(code)) return "DRG";

  return undefined;
}

// S74.5c §2.4 — Reconcile Haiku's emitted procedureCodeType with format-based
// inference. The Haiku Rule #12 prompt orders "letter+4digit = HCPCS_L2"
// before "G+4digit = G_CODE" + "4-digit ending in F = CAT_II"; Haiku may match
// the broader rule first and emit HCPCS_L2 for a G-code (G0008 → HCPCS_L2 vs
// the correct G_CODE) or CPT for a Category II code (3074F → CPT). When the
// format-inference says G_CODE or CAT_II, that override is unambiguous (regex
// distinctions are sharp) — prefer it over Haiku's emission.
//
// Other code types: Haiku has document context (column headers, surrounding
// rows) and is generally trusted over format alone.
export function reconcileHaikuCodeType(
  code: string,
  haikuEmitted: ProcedureCodeType | undefined,
): ProcedureCodeType | undefined {
  const inferred = inferProcedureCodeType(code);
  if (inferred === "G_CODE" && haikuEmitted !== "G_CODE") return "G_CODE";
  if (inferred === "CAT_II" && haikuEmitted !== "CAT_II") return "CAT_II";
  return haikuEmitted ?? inferred;
}

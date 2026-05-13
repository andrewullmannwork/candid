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

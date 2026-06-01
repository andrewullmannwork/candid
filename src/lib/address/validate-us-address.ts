/**
 * validate-us-address — single source of truth for "is this a valid US mailing
 * address?" across the dispute surface.
 *
 * Both the provider billing-address form (ProviderAddressForm) and the insurer
 * appeals-address correction modal (InsurerAddressCorrectionModal) validate
 * through this helper so the two address surfaces never drift. Format-level only
 * (required fields + ZIP/state shape) — NOT third-party deliverability
 * verification (deferred: external API + PII boundary + AKS review).
 *
 * Pure + side-effect-free. Returns a per-field error map; empty map === valid.
 */

export interface UsAddressFields {
  /** Street line 1 — required. */
  addressLine1: string;
  /** Suite / unit — optional. */
  addressLine2?: string;
  /** City — required. */
  city: string;
  /** Two-letter USPS state/territory code — required. */
  state: string;
  /** 5-digit or ZIP+4 — required. */
  postalCode: string;
}

export type UsAddressErrorField = "addressLine1" | "city" | "state" | "postalCode";
export type UsAddressErrors = Partial<Record<UsAddressErrorField, string>>;

/**
 * USPS state + territory two-letter codes. Validating against the real set (not
 * just `/^[A-Z]{2}$/`) rejects typos like "ZZ" that would pass a shape-only
 * check and produce an undeliverable letter.
 */
export const US_STATE_CODES: ReadonlySet<string> = new Set([
  // 50 states
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  // District + inhabited territories (USPS-deliverable)
  "DC", "PR", "VI", "GU", "AS", "MP",
  // Military / diplomatic
  "AA", "AE", "AP",
]);

/** 5-digit ZIP or ZIP+4 (e.g. 94304 or 94304-1234). */
export const US_ZIP_RE = /^\d{5}(-\d{4})?$/;

/**
 * Validate a US address. Returns a map of field → human error message; an empty
 * object means the address is valid. `addressLine2` is never required.
 */
export function validateUsAddress(fields: UsAddressFields): UsAddressErrors {
  const errors: UsAddressErrors = {};

  if (!fields.addressLine1?.trim()) {
    errors.addressLine1 = "Street address is required.";
  }
  if (!fields.city?.trim()) {
    errors.city = "City is required.";
  }

  const state = fields.state?.trim().toUpperCase();
  if (!state) {
    errors.state = "State is required.";
  } else if (!US_STATE_CODES.has(state)) {
    errors.state = "Enter a valid 2-letter state code (e.g. CA).";
  }

  const zip = fields.postalCode?.trim();
  if (!zip) {
    errors.postalCode = "ZIP code is required.";
  } else if (!US_ZIP_RE.test(zip)) {
    errors.postalCode = "Enter a 5-digit ZIP (e.g. 94304 or 94304-1234).";
  }

  return errors;
}

/** True when the address passes all required-field + format checks. */
export function isValidUsAddress(fields: UsAddressFields): boolean {
  return Object.keys(validateUsAddress(fields)).length === 0;
}

/**
 * Compose structured fields into the single newline-joined display string the
 * dispute letter renders (templates read `provider.address` as plain text). Keeps
 * the letter byte-shape identical to a hand-typed address. Trims empties.
 */
export function composeUsAddress(fields: UsAddressFields): string {
  const line2 = fields.addressLine2?.trim();
  const cityStateZip = [
    fields.city?.trim(),
    [fields.state?.trim().toUpperCase(), fields.postalCode?.trim()]
      .filter(Boolean)
      .join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  return [fields.addressLine1?.trim(), line2 || null, cityStateZip]
    .filter(Boolean)
    .join("\n");
}

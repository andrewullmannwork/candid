/**
 * Shared types for the admin cold-start seeding scripts (S102/S103).
 *
 * The seeding flow is manifest-driven: each entry describes one SBC PDF
 * to download + upload as admin. The manifest is hand-curated for the
 * first pass; future sessions can automate discovery from exchange APIs.
 */

export type StateCode =
  | "CA" | "TX" | "FL" | "NY" | "PA" | "IL" | "OH" | "GA" | "NC"
  // catch-all for follow-up sessions expanding coverage
  | string;

export type ExchangeSource =
  | "covered_california"
  | "healthcare_gov"
  | "ny_state_of_health"
  | "pennie_pa"
  | "get_covered_il"
  | "insurer_direct";

export interface ManifestEntry {
  /** Stable identifier for this seed row — used as filename + log key. */
  seed_id: string;
  /** Two-letter state code (CA, TX, etc.). */
  state: StateCode;
  /** Source exchange or insurer-direct download. */
  source: ExchangeSource;
  /** Insurer human-readable name (e.g., "Kaiser Permanente", "Blue Shield of CA"). */
  insurer_name: string;
  /** Plan name as shown on the exchange (e.g., "Bronze 60 HMO"). */
  plan_name: string;
  /** HIOS plan ID if known (14-char format: insurer + state + product + plan + variant). */
  hios_plan_id?: string;
  /** Plan year (2025, 2026). */
  plan_year: number;
  /** Direct URL to the SBC PDF (insurer-hosted in most cases). */
  sbc_url: string;
  /** Optional: URL to the plan brochure (not the SBC; sometimes useful for cross-reference). */
  brochure_url?: string;
  /** Optional: exchange "plan details" page URL for traceability. */
  exchange_plan_details_url?: string;
  /** Free-text notes (e.g., "two-PCP-visit variant", "child dental rider"). */
  notes?: string;
}

export interface DownloadOutcome {
  seed_id: string;
  status: "ok" | "fetch_error" | "not_pdf" | "size_exceeded";
  local_path?: string;
  file_hash?: string;
  file_size_bytes?: number;
  error_message?: string;
  downloaded_at: string;
}

export interface UploadOutcome {
  seed_id: string;
  status: "ok" | "upload_error" | "parse_error" | "parse_timeout" | "no_canonical_match";
  document_id?: string;
  canonical_plan_id?: string;
  service_count?: number;
  promotion_event_count?: number;
  error_message?: string;
  uploaded_at: string;
  parse_completed_at?: string;
}

export interface SeedLogEntry {
  manifest: ManifestEntry;
  download?: DownloadOutcome;
  upload?: UploadOutcome;
}

// Candid Care types

export interface PricingAggregate {
  procedure_code: string;
  procedure_category: string | null;
  region: string;
  facility_name: string | null;
  facility_npi: string | null;
  data_points: number;
  avg_billed: number;
  median_billed: number;
  min_billed: number;
  max_billed: number;
  avg_allowed: number | null;
  avg_patient_paid: number | null;
  aggregate_confidence: number;
  last_updated: string;
}

export interface CareDataStatus {
  totalDataPoints: number;
  userBillPoints: number;
  publicDataPoints: number;
  regionsWithData: number;
  uniqueProcedures: number;
  isLive: boolean; // Whether Candid Care has enough data to be useful
}

// Minimum data points per region before Candid Care goes live for that region
export const MIN_DATA_POINTS_PER_REGION = 500;

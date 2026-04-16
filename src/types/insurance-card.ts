/** Structured fields extracted from an insurance card (OCR → Haiku/regex) */
export interface InsuranceCardFields {
  insurer?: string;
  planName?: string;
  planType?: string;
  groupNumber?: string;
  memberId?: string;
  copayPrimary?: number;
  copaySpecialist?: number;
  copayEr?: number;
  copayUrgentCare?: number;
  copayRx?: number;
  deductibleIndividual?: number;
  deductibleFamily?: number;
  oopMaxIndividual?: number;
  oopMaxFamily?: number;
  coinsurancePct?: number;
  rxBin?: string;
  rxPcn?: string;
  rxGroup?: string;
  networkName?: string;
  insurerPhone?: string;
  zipCode?: string;
  rawText: string;
}

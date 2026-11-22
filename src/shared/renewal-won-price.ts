export interface AcceptedPriceSource {
  kind: 'PRICE_REVISION';
  caseId: string;
  expectedCaseVersion: number;
  revisionId: string;
  acceptanceEventId: string;
}

export interface WonPriceOption {
  source: AcceptedPriceSource;
  insurerId: string;
  insurerName: string;
  branchId: string;
  amountMinor: number;
  currency: string;
  startDate: string | null;
  endDate: string | null;
}

export interface WonPriceOptions {
  options: WonPriceOption[];
  nextAfter: string | null;
}

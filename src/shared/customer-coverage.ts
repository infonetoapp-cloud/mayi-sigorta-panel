export interface CoveragePolicy {
  readonly policyId: string;
  readonly policyNumber: string;
  readonly branchName: string;
  readonly productName: string;
  readonly insurerName: string;
  readonly startDate: string;
  readonly endDate: string;
}
/** Counts describe only currently authorized policyholder records, not Tasks or parties. */
export interface CustomerCoverageSummary {
  readonly available: boolean;
  readonly asOfDate: string;
  readonly timezone: string;
  readonly activePolicyCount: number | null;
  readonly expiredPolicyCount: number | null;
  readonly scheduledPolicyCount: number | null;
  readonly cancelledPolicyCount: number | null;
  readonly voidedPolicyCount: number | null;
  readonly archivedPolicyCount: number | null;
  readonly invalidPeriodPolicyCount: number | null;
  readonly types: readonly { readonly label: string; readonly count: number }[];
  readonly additionalTypeCount: number;
  readonly nearestExpiry: CoveragePolicy | null;
  readonly policies: readonly CoveragePolicy[];
}

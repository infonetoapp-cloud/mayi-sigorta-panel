/**
 * Paylaşılan tip tanımları (Tip güvenliği için katı standartlar).
 *
 * MİMARİ STANDART:
 * `any` kullanımı yasaktır. Tüm veri yapıları açık tiplerle tanımlanır.
 */

export interface ApiSuccessEnvelope<T> {
  success: true;
  data: T;
  timestamp: string;
}

export interface ApiErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
  };
  timestamp: string;
}

export type ApiResponse<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

export interface HealthCheckData {
  status: 'healthy';
  version: string;
  environment: string;
  timestamp: string;
}

export interface CsrfTokenDto {
  readonly token: string;
}

/**
 * Kimlik ve Aktif Üyelik Bağlamı DTO'ları (M1-T06 - GET /api/me).
 *
 * KRİTİK GÜVENLİK SÖZLEŞMESİ:
 * - Yalnızca güvenli kimlik bilgileri, doğrulanmış e-posta ve aktif üyelik bağlamları içerir.
 * - Ham belirteçler, veritabanı içsel alanları (timestamps/versions), izin hesaplama
 *   veya yetki sonuçları bu DTO'ya KESİNLİKLE DAHİL EDİLEMEZ.
 */
export interface UserMeMembershipDto {
  readonly id: string;
  readonly agencyId: string;
  readonly type: 'OWNER' | 'MEMBER';
  readonly status: 'ACTIVE';
}

export interface UserMeDto {
  readonly userId: string;
  readonly email?: string;
  readonly assurance: 'NORMAL' | 'SECURE';
  readonly memberships: readonly UserMeMembershipDto[];
}

export type CustomerType = 'INDIVIDUAL' | 'COMPANY';
export type CompanyContactStatus = 'ACTIVE' | 'INACTIVE';

export interface CustomerDto {
  readonly coverage?: import('./customer-coverage').CustomerCoverageSummary;
  readonly id: string;
  readonly agencyId: string;
  readonly type: CustomerType;
  readonly displayName: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyTitle: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: string | null;
  readonly assigneeMembershipId: string;
  readonly archivedAt: string | null;
  readonly archivedByMembershipId: string | null;
  readonly archiveReasonCode: string | null;
  readonly hasIdentity: boolean;
  readonly identityMasked: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CompanyContactDto {
  readonly id: string;
  readonly agencyId: string;
  readonly customerId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly isPrimary: boolean;
  readonly status: CompanyContactStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomerDetailDto extends CustomerDto {
  readonly contacts?: readonly CompanyContactDto[];
}

export interface CustomerIdentityRevealDto {
  readonly customerId: string;
  readonly identityType: 'TCKN' | 'VKN';
  readonly identityValue: string;
}

export interface ExternalCustomerReferenceDto {
  readonly id: string;
  readonly agencyId: string;
  readonly customerId: string;
  readonly sourceNamespace: string;
  readonly externalKey: string;
  readonly createdAt: string;
}

export interface CustomerAssignmentOptionDto {
  readonly membershipId: string;
  readonly label: string;
  readonly membershipType: 'OWNER' | 'MEMBER';
}

export interface CustomerListResponseData {
  readonly items: readonly CustomerDto[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly total?: number;
}

export type CatalogLifecycleStatus = 'ACTIVE' | 'INACTIVE';

export interface InsurerDto {
  readonly id: string;
  readonly agencyId: string;
  readonly code: string;
  readonly name: string;
  readonly status: CatalogLifecycleStatus;
  readonly isDefault?: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InsuranceBranchDto {
  readonly id: string;
  readonly agencyId: string;
  readonly code: string;
  readonly name: string;
  readonly dataClassification: 'GENERAL' | 'HEALTH';
  readonly status: CatalogLifecycleStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InsuranceProductDto {
  readonly id: string;
  readonly agencyId: string;
  readonly insurerId: string;
  readonly branchId: string;
  readonly code: string;
  readonly name: string;
  readonly status: CatalogLifecycleStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PaymentMethodDto {
  readonly id: string;
  readonly agencyId: string;
  readonly code: string;
  readonly name: string;
  readonly supportsInstallments: boolean;
  readonly maxInstallments: number;
  readonly status: CatalogLifecycleStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LossReasonDto {
  readonly id: string;
  readonly agencyId: string;
  readonly code: string;
  readonly name: string;
  readonly status: CatalogLifecycleStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgencySettingsDto {
  readonly id: string;
  readonly agencyId: string;
  readonly defaultInsurerId: string | null;
  readonly timezone: string;
  readonly renewalWindowDays: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SelectableCatalogsDto {
  readonly insurers: readonly InsurerDto[];
  readonly branches: readonly InsuranceBranchDto[];
  readonly products: readonly InsuranceProductDto[];
  readonly paymentMethods: readonly PaymentMethodDto[];
  readonly lossReasons: readonly LossReasonDto[];
  readonly defaultInsurerId: string | null;
}

export type PolicyStatus = 'ACTIVE' | 'CANCELLED' | 'VOIDED';
export interface PolicyDto {
  readonly labels?: {
    readonly branchName: string;
    readonly productName: string;
    readonly insurerName: string;
  };
  readonly id: string;
  readonly agencyId: string;
  readonly customerId: string;
  readonly insurerId: string;
  readonly productId: string;
  readonly branchId: string;
  readonly paymentMethodId: string;
  readonly assigneeMembershipId: string;
  readonly policyNumber: string;
  readonly normalizedPolicyNumber: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly grossPremiumMinor: number;
  readonly currency: string;
  readonly installmentCount: number | null;
  readonly status: PolicyStatus;
  readonly identityVariant: number;
  readonly archivedAt: string | null;
  readonly archivedByMembershipId: string | null;
  readonly archiveReason: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PolicyPartyRole = 'INSURED' | 'BENEFICIARY';
export interface PolicyPartyDto {
  readonly id: string;
  readonly agencyId: string;
  readonly policyId: string;
  readonly customerId: string;
  readonly customerDisplayName: string;
  readonly role: PolicyPartyRole;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly version: number;
  readonly deactivatedAt: string | null;
  readonly deactivatedByMembershipId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PolicyAmendmentDto {
  readonly id: string;
  readonly agencyId: string;
  readonly policyId: string;
  readonly externalReference: string;
  readonly effectiveDate: string;
  readonly description: string;
  readonly premiumDifferenceMinor: number | null;
  readonly currency: string | null;
  readonly createdAt: string;
}

export interface PolicyExternalReferenceDto {
  readonly id: string;
  readonly agencyId: string;
  readonly policyId: string;
  readonly sourceNamespace: string;
  readonly externalKey: string;
  readonly createdAt: string;
}

export interface PolicyDetailDto extends PolicyDto {
  readonly customer: { readonly id: string; readonly displayName: string };
  readonly insurer: {
    readonly id: string;
    readonly name: string;
    readonly status: CatalogLifecycleStatus;
  };
  readonly product: {
    readonly id: string;
    readonly name: string;
    readonly status: CatalogLifecycleStatus;
  };
  readonly branch: {
    readonly id: string;
    readonly name: string;
    readonly status: CatalogLifecycleStatus;
    readonly dataClassification: 'GENERAL' | 'HEALTH';
  };
  readonly paymentMethod: {
    readonly id: string;
    readonly name: string;
    readonly status: CatalogLifecycleStatus;
  };
}

export interface PolicyListResponseData {
  readonly items: readonly PolicyDto[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export type TaskDueBucket = 'OVERDUE' | 'TODAY' | 'UPCOMING';
export interface CustomerNoteDto {
  readonly id: string;
  readonly content: string;
  readonly authorName: string | null;
  readonly createdAt: string;
}
export interface CustomerNotesPage {
  readonly items: readonly CustomerNoteDto[];
  readonly nextCursor: string | null;
  readonly canCreate: boolean;
}

export interface TodayTaskDto {
  readonly taskId: string;
  readonly renewalId: string;
  readonly customerId: string;
  readonly customerDisplayName: string;
  readonly customerEmail: string | null;
  readonly customerPhone: string | null;
  readonly policyId: string | null;
  readonly policyNumber: string | null;
  readonly policyEndDate: string | null;
  readonly title: string;
  readonly dueAt: string;
  readonly assigneeMembershipId: string | null;
  readonly taskVersion: number;
  readonly renewalAssigneeMembershipId: string | null;
  readonly renewalState: RenewalStateCode;
  readonly renewalVersion: number;
  readonly bucket: TaskDueBucket;
  readonly isUnassigned: boolean;
  readonly needsReassignment?: boolean;
}

export type RenewalStateCode =
  | 'CONTACT_PENDING'
  | 'CONTACTED'
  | 'QUOTE_PREPARING'
  | 'QUOTE_SENT'
  | 'AWAITING_RESPONSE'
  | 'WON'
  | 'LOST'
  | 'VOIDED';

export interface TodayTasksResponseData {
  readonly items: readonly TodayTaskDto[];
  readonly unassignedItems: readonly TodayTaskDto[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly unassignedNextCursor: string | null;
  readonly unassignedHasMore: boolean;
  readonly canSeeUnassigned: boolean;
  readonly canSeeReassignment?: boolean;
  readonly canAssign: boolean;
  readonly timezone: string;
  readonly todayLocalDate: string;
  readonly now: string;
}

export interface RenewalTaskAssignmentDto {
  readonly renewalId: string;
  readonly taskId: string;
  readonly assigneeMembershipId: string | null;
  readonly renewalVersion: number;
  readonly taskVersion: number;
  readonly updatedAt: string;
}

export interface RenewalTaskReplacementCompletionDto {
  readonly renewalId: string;
  readonly completedTaskId: string;
  readonly replacementTaskId: string;
  readonly replacementDueAt: string;
  readonly completedTaskVersion: number;
  readonly replacementTaskVersion: number;
  readonly renewalVersion: number;
  readonly completedAt: string;
}

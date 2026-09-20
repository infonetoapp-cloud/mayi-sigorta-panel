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

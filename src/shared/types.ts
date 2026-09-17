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

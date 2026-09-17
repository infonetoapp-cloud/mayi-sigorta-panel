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

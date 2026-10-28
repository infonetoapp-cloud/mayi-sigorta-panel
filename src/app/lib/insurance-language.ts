import type { RenewalStateCode } from '../../shared/types';
const renewalLabels: Record<RenewalStateCode, string> = {
  CONTACT_PENDING: 'İletişim bekleniyor',
  CONTACTED: 'Görüşüldü',
  QUOTE_PREPARING: 'Teklif hazırlanıyor',
  QUOTE_SENT: 'Teklif gönderildi',
  AWAITING_RESPONSE: 'Yanıt bekleniyor',
  WON: 'Yenilendi',
  LOST: 'Yenilenmedi',
  VOIDED: 'Geçersiz',
};
export function renewalStateLabel(value: string): string {
  return Object.hasOwn(renewalLabels, value)
    ? renewalLabels[value as RenewalStateCode]
    : 'Durum bilgisi bulunmuyor';
}
export const archiveReasons = {
  HISTORICAL_RECORD: 'Yalnız geçmişte izlenecek kayıt',
  PORTFOLIO_CLOSED: 'Günlük portföyden çıkarma',
  DUPLICATE_RECORD: 'Mükerrer kayıt',
} as const;

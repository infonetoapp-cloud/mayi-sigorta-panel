import type { RenewalStateCode } from './types';
import type { PolicyVehicle } from './vehicles';
export const renewalStateLabels: Record<RenewalStateCode, string> = {
  CONTACT_PENDING: 'İletişim bekleniyor',
  CONTACTED: 'Görüşüldü',
  QUOTE_PREPARING: 'Teklif hazırlanıyor',
  QUOTE_SENT: 'Teklif gönderildi',
  AWAITING_RESPONSE: 'Yanıt bekleniyor',
  WON: 'Yenilendi',
  LOST: 'Yenilenmedi',
  VOIDED: 'Geçersiz',
};
export interface RenewalBrowseItem {
  readonly id: string;
  readonly state: RenewalStateCode;
  readonly version: number;
  readonly closedAt: string | null;
  readonly customer: { id: string; displayName: string };
  readonly policy: {
    id: string;
    number: string;
    startDate: string;
    endDate: string;
    insurerName: string;
    branchName: string;
    grossPremiumMinor: number;
    currency: string;
    status: 'ACTIVE' | 'CANCELLED' | 'VOIDED';
  };
  readonly isOpen: boolean;
  readonly parentArchived: boolean;
}
export interface RenewalBrowseDetail extends RenewalBrowseItem {
  readonly phone: string | null;
  readonly email: string | null;
  readonly referenceName: string | null;
  readonly insurerCustomerNumber: string | null;
  readonly vehicle: PolicyVehicle | null;
}
export interface RenewalBrowsePage {
  readonly items: readonly RenewalBrowseItem[];
  readonly nextCursor: string | null;
}

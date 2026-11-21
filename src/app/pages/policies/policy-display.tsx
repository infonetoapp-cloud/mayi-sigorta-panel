import type { PolicyStatus } from '../../../shared/types';
import { z } from 'zod';
import { istanbulToday } from '../../../shared/customer-profile';
import { Button } from '../../components/ui/button';

export const policyStatusLabel: Record<PolicyStatus, string> = {
  ACTIVE: 'Aktif',
  CANCELLED: 'İptal',
  VOIDED: 'Geçersiz',
};

/** Record status alone does not establish coverage. Dates are inclusive, Istanbul date-only. */
export function policyPeriodLabel(
  policy: { status: PolicyStatus; startDate: string; endDate: string; archivedAt?: string | null },
  today = istanbulToday(),
): string {
  if (policy.archivedAt) return 'Arşivlenmiş kayıt';
  if (policy.status !== 'ACTIVE') return policyStatusLabel[policy.status];
  if (
    !calendarDate.safeParse(policy.startDate).success ||
    !calendarDate.safeParse(policy.endDate).success ||
    policy.endDate < policy.startDate
  )
    return 'Tarih kontrolü gerekiyor';
  if (policy.startDate > today) return 'Henüz başlamadı';
  if (policy.endDate < today) return 'Süresi doldu';
  return 'Yürürlükte';
}

export function PolicyPeriodBadge({ policy }: { policy: Parameters<typeof policyPeriodLabel>[0] }) {
  const label = policyPeriodLabel(policy);
  return (
    <span className="customer-badge policy-period" data-current={label === 'Yürürlükte'}>
      {label}
    </span>
  );
}
/** All supported amounts are safe integer minor units, never floating-point major units. */
export function policyMoney(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) return 'Tutar kullanılamıyor';
  const value = BigInt(minor),
    negative = value < 0n,
    absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${new Intl.NumberFormat('tr-TR').format(absolute / 100n)},${(absolute % 100n).toString().padStart(2, '0')} ${currency}`;
}
export function policyDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Tarih kontrolü gerekiyor';
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    dateStyle: 'medium',
  }).format(date);
}
const calendarDate = z.iso.date();
export function storedPolicyDate(value: string): string {
  return calendarDate.safeParse(value).success ? policyDate(value) : 'Tarih kontrolü gerekiyor';
}
export function PolicyReadNotice({
  loading,
  error,
  reload,
}: {
  loading: boolean;
  error?: { status: number; message: string };
  reload: () => void;
}) {
  return (
    <>
      {loading && (
        <p role="status" className="customer-state">
          Poliçe bilgileri yükleniyor…
        </p>
      )}
      {error && (
        <div className="customer-state">
          <h2>
            {error.status === 403
              ? 'Erişim izni gerekli'
              : error.status === 404
                ? 'Poliçe kullanılamıyor'
                : error.status === 400
                  ? 'Filtreleri kontrol edin'
                  : 'Poliçe bilgileri yüklenemedi'}
          </h2>
          <p role="alert">{error.message}</p>
          {![401, 403, 404].includes(error.status) && (
            <Button variant="outline" onClick={reload}>
              Yeniden dene
            </Button>
          )}
        </div>
      )}
    </>
  );
}

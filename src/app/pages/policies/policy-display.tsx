import type { PolicyStatus } from '../../../shared/types';
import { Button } from '../../components/ui/button';

export const policyStatusLabel: Record<PolicyStatus, string> = {
  ACTIVE: 'Aktif',
  CANCELLED: 'İptal',
  VOIDED: 'Geçersiz',
};
/** All supported amounts are safe integer minor units, never floating-point major units. */
export function policyMoney(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) return 'Tutar kullanılamıyor';
  const value = BigInt(minor),
    negative = value < 0n,
    absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${new Intl.NumberFormat('tr-TR').format(absolute / 100n)},${(absolute % 100n).toString().padStart(2, '0')} ${currency}`;
}
export function policyDate(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    dateStyle: 'medium',
  }).format(new Date(value));
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
        <div role="alert" className="customer-state">
          <h2>
            {error.status === 403
              ? 'Erişim izni gerekli'
              : error.status === 404
                ? 'Poliçe kullanılamıyor'
                : error.status === 400
                  ? 'Filtreleri kontrol edin'
                  : 'Poliçe bilgileri yüklenemedi'}
          </h2>
          <p>{error.message}</p>
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

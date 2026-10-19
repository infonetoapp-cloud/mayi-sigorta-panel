import type { SelectableCatalogsDto } from '../../../shared/types';
import type { VersionPayload } from '../../components/RenewalQuoteForm';
import { premiumInput, premiumMinor } from '../policies/policy-form-model';
import { canonicalOccurrence, localOccurrence } from './interaction-model';
export type { VersionPayload };
export interface QuoteVersion {
  id: string;
  version_number: number;
  insurer_id: string;
  product_id: string;
  product_name?: string;
  branch_id: string;
  payment_method_id: string;
  start_date: string;
  end_date: string;
  valid_until: string;
  gross_premium_minor: number;
  currency: string;
  installment_count: number | null;
  terms_summary: string | null;
  created_at?: string;
}
export interface QuoteRecord {
  id: string;
  status: string;
  version: number;
  current_version_id: string | null;
  accepted_version_id: string | null;
  created_at?: string;
  updated_at?: string;
  versions: QuoteVersion[];
  events: { id: string; quote_version_id: string | null; event: string; occurred_at: string }[];
}
export interface QuoteHistory {
  quotes: QuoteRecord[];
  defaultVersion: VersionPayload;
}
export type QuoteDraft = Omit<
  VersionPayload,
  'grossPremiumMinor' | 'validUntil' | 'installmentCount' | 'termsSummary'
> & { premium: string; validUntil: string; installmentCount: string; termsSummary: string };
export function quoteDraft(v: VersionPayload): QuoteDraft {
  return {
    insurerId: v.insurerId,
    productId: v.productId,
    branchId: v.branchId,
    paymentMethodId: v.paymentMethodId,
    startDate: v.startDate,
    endDate: v.endDate,
    validUntil:
      localOccurrence(v.validUntil) +
      (new Date(v.validUntil).getUTCMilliseconds()
        ? '.' + String(new Date(v.validUntil).getUTCMilliseconds()).padStart(3, '0')
        : ''),
    premium: premiumInput(v.grossPremiumMinor),
    currency: v.currency,
    installmentCount: v.installmentCount === null ? '' : String(v.installmentCount),
    termsSummary: v.termsSummary ?? '',
  };
}
export function savedPayload(v: QuoteVersion): VersionPayload {
  return {
    insurerId: v.insurer_id,
    productId: v.product_id,
    branchId: v.branch_id,
    paymentMethodId: v.payment_method_id,
    startDate: v.start_date,
    endDate: v.end_date,
    validUntil: v.valid_until,
    grossPremiumMinor: v.gross_premium_minor,
    currency: v.currency,
    installmentCount: v.installment_count,
    termsSummary: v.terms_summary,
  };
}
function dateOnly(s: string) {
  const d = new Date(s + 'T00:00:00.000Z');
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(d.getTime()) &&
    d.toISOString() === s + 'T00:00:00.000Z'
  );
}
export function quotePayload(
  d: QuoteDraft,
  catalogs: SelectableCatalogsDto,
  branchId: string,
  now = Date.now(),
): VersionPayload | null {
  const premium = premiumMinor(d.premium.trim().replace(',', '.')),
    parts = d.validUntil.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,3}))?$/),
    utc = parts ? canonicalOccurrence(parts[1]!) : null,
    validUntil = utc ? utc.slice(0, 19) + '.' + (parts?.[2] ?? '').padEnd(3, '0') + 'Z' : null;
  const insurer = catalogs.insurers.find((r) => r.id === d.insurerId && r.status === 'ACTIVE'),
    branch = catalogs.branches.find(
      (r) => r.id === d.branchId && r.id === branchId && r.status === 'ACTIVE',
    ),
    product = catalogs.products.find(
      (r) =>
        r.id === d.productId &&
        r.insurerId === insurer?.id &&
        r.branchId === branch?.id &&
        r.status === 'ACTIVE',
    ),
    payment = catalogs.paymentMethods.find(
      (r) => r.id === d.paymentMethodId && r.status === 'ACTIVE',
    );
  const installments =
    d.installmentCount === ''
      ? null
      : /^(?:[2-9]|[12]\d|3[0-6])$/.test(d.installmentCount)
        ? Number(d.installmentCount)
        : NaN;
  if (
    premium === null ||
    !dateOnly(d.startDate) ||
    !dateOnly(d.endDate) ||
    d.endDate <= d.startDate ||
    !validUntil ||
    Date.parse(validUntil) <= now ||
    !new Set(Intl.supportedValuesOf('currency')).has(d.currency) ||
    d.termsSummary.trim().length > 1000 ||
    !insurer ||
    !branch ||
    !product ||
    !payment ||
    insurer.agencyId !== product.agencyId ||
    branch.agencyId !== product.agencyId ||
    payment.agencyId !== product.agencyId ||
    (installments !== null &&
      (!Number.isInteger(installments) ||
        !payment.supportsInstallments ||
        installments > payment.maxInstallments))
  )
    return null;
  return {
    insurerId: d.insurerId,
    productId: d.productId,
    branchId: d.branchId,
    paymentMethodId: d.paymentMethodId,
    startDate: d.startDate,
    endDate: d.endDate,
    validUntil,
    grossPremiumMinor: Number(premium),
    currency: d.currency,
    installmentCount: installments,
    termsSummary: d.termsSummary.trim() || null,
  };
}
export function quoteMatches(v: QuoteVersion, p: VersionPayload) {
  const saved = savedPayload(v);
  return Object.keys(p).every(
    (k) => saved[k as keyof VersionPayload] === p[k as keyof VersionPayload],
  );
}
export const quoteStatuses: Record<string, string> = {
  DRAFT: 'Taslak',
  READY: 'Hazır',
  SENT: 'Gönderildi durumu',
  ACCEPTED: 'Kabul edildi',
  REJECTED: 'Reddedildi',
  EXPIRED: 'Süresi doldu',
};

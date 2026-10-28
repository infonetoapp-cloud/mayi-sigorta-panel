import type { PolicyDetailDto, SelectableCatalogsDto } from '../../../shared/types';
import { parseMoneyInput, MONEY_INPUT_HELP } from '../../lib/monetary';
export type PolicyDraft = {
  insurerId: string;
  branchId: string;
  productId: string;
  paymentMethodId: string;
  policyNumber: string;
  startDate: string;
  endDate: string;
  grossPremium: string;
  currency: string;
  installmentCount: string;
  status: string;
};
export const blankPolicyDraft: PolicyDraft = {
  insurerId: '',
  branchId: '',
  productId: '',
  paymentMethodId: '',
  policyNumber: '',
  startDate: '',
  endDate: '',
  grossPremium: '',
  currency: 'TRY',
  installmentCount: '',
  status: 'ACTIVE',
};
export function premiumMinor(value: string): bigint | null {
  return parseMoneyInput(value)?.minor ?? null;
}
export function premiumInput(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error('INVALID_PREMIUM');
  const value = BigInt(minor);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}
export function policyDraft(policy: PolicyDetailDto): PolicyDraft {
  return {
    insurerId: policy.insurerId,
    branchId: policy.branchId,
    productId: policy.productId,
    paymentMethodId: policy.paymentMethodId,
    policyNumber: policy.policyNumber,
    startDate: policy.startDate,
    endDate: policy.endDate,
    grossPremium: premiumInput(policy.grossPremiumMinor),
    currency: policy.currency,
    installmentCount: policy.installmentCount?.toString() ?? '',
    status: policy.status,
  };
}
export function contractValues(
  draft: PolicyDraft,
): Record<keyof PolicyDraft, string | number | null> {
  return {
    ...draft,
    policyNumber: draft.policyNumber.trim(),
    grossPremium: parseMoneyInput(draft.grossPremium)?.canonical ?? draft.grossPremium.trim(),
    installmentCount: draft.installmentCount ? Number(draft.installmentCount) : null,
  };
}
export function policyChanges(
  draft: PolicyDraft,
  original: PolicyDetailDto,
): Record<string, string | number | null> {
  const before = contractValues(policyDraft(original)),
    after = contractValues(draft);
  const changes: Record<string, string | number | null> = {};
  for (const key of Object.keys(after) as Array<keyof PolicyDraft>)
    if (
      key === 'grossPremium'
        ? premiumMinor(String(after[key])) !== BigInt(original.grossPremiumMinor)
        : before[key] !== after[key]
    )
      changes[key] = after[key];
  return changes;
}
function dateOnly(value: string) {
  const date = new Date(value + 'T00:00:00Z');
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}
/** Helpful client validation only; server remains the business/permission authority. */
export function validatePolicy(
  draft: PolicyDraft,
  catalogs: SelectableCatalogsDto,
  checkCatalogs: boolean,
): Partial<Record<keyof PolicyDraft, string>> {
  const errors: Partial<Record<keyof PolicyDraft, string>> = {};
  if (
    !draft.policyNumber.trim() ||
    draft.policyNumber.trim().length > 200 ||
    !/[\p{L}\p{N}]/u.test(draft.policyNumber)
  )
    errors.policyNumber = 'Poliçe numarası zorunludur (en fazla 200 karakter).';
  if (!dateOnly(draft.startDate)) errors.startDate = 'Geçerli bir başlangıç tarihi girin.';
  if (!dateOnly(draft.endDate)) errors.endDate = 'Geçerli bir bitiş tarihi girin.';
  if (!errors.startDate && !errors.endDate && draft.startDate > draft.endDate)
    errors.endDate = 'Bitiş tarihi başlangıçtan önce olamaz.';
  if (premiumMinor(draft.grossPremium.trim()) === null) errors.grossPremium = MONEY_INPUT_HELP;
  if (
    !/^[A-Z]{3}$/.test(draft.currency) ||
    !new Set(Intl.supportedValuesOf('currency')).has(draft.currency)
  )
    errors.currency = 'Geçerli üç büyük harfli ISO para birimi girin (TRY, EUR, USD).';
  if (!['ACTIVE', 'CANCELLED', 'VOIDED'].includes(draft.status))
    errors.status = 'Geçerli poliçe durumunu seçin.';
  if (checkCatalogs) {
    if (!catalogs.insurers.some((x) => x.id === draft.insurerId && x.status === 'ACTIVE'))
      errors.insurerId = 'Seçilebilir bir sigorta şirketi seçin.';
    if (!catalogs.branches.some((x) => x.id === draft.branchId && x.status === 'ACTIVE'))
      errors.branchId = 'Seçilebilir bir branş seçin.';
    if (
      !catalogs.products.some(
        (x) =>
          x.id === draft.productId &&
          x.insurerId === draft.insurerId &&
          x.branchId === draft.branchId &&
          x.status === 'ACTIVE',
      )
    )
      errors.productId = 'Seçilen sigortacı ve branşa bağlı aktif ürünü seçin.';
    const payment = catalogs.paymentMethods.find(
      (x) => x.id === draft.paymentMethodId && x.status === 'ACTIVE',
    );
    if (!payment) errors.paymentMethodId = 'Seçilebilir bir ödeme yöntemi seçin.';
    else if (
      payment.supportsInstallments &&
      (!/^\d+$/.test(draft.installmentCount) ||
        Number(draft.installmentCount) < 2 ||
        Number(draft.installmentCount) > Math.min(36, payment.maxInstallments))
    )
      errors.installmentCount = `Taksit sayısı 2–${Math.min(36, payment.maxInstallments)} arasında olmalıdır.`;
    else if (!payment.supportsInstallments && draft.installmentCount !== '')
      errors.installmentCount = 'Bu ödeme yöntemi taksit desteklemiyor.';
  }
  return errors;
}

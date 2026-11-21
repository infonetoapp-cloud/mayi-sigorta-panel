import type { QuoteRecord, QuoteVersion } from './quote-model';
export interface SelectedWonQuote {
  quoteId: string;
  quoteCas: number;
  version: QuoteVersion;
}
export function eligibleWonQuote(q: QuoteRecord): SelectedWonQuote | null {
  if (
    typeof q.id !== 'string' ||
    !q.id ||
    typeof q.current_version_id !== 'string' ||
    !q.current_version_id ||
    q.status !== 'SENT' ||
    !Number.isSafeInteger(q.version) ||
    !Array.isArray(q.versions) ||
    !Array.isArray(q.events)
  )
    return null;
  const versions = q.versions.filter((v) => v.id === q.current_version_id);
  if (versions.length !== 1) return null;
  const v = versions[0]!;
  if (
    ![v.id, v.insurer_id, v.product_id, v.branch_id, v.payment_method_id].every(
      (id) => typeof id === 'string' && id.length > 0,
    ) ||
    !v.product_id ||
    !Number.isSafeInteger(v.gross_premium_minor) ||
    v.gross_premium_minor < 0 ||
    !/^[A-Z]{3}$/.test(v.currency) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.valid_until) ||
    !Number.isFinite(Date.parse(v.valid_until)) ||
    new Date(v.valid_until).toISOString() !== v.valid_until ||
    Date.parse(v.valid_until) <= Date.now() ||
    !q.events.some((e) => e.event === 'SENT' && e.quote_version_id === v.id)
  )
    return null;
  return { quoteId: q.id, quoteCas: q.version, version: structuredClone(v) };
}

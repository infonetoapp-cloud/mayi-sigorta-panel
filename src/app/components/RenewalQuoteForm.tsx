import { useEffect, useState } from 'react';
import type { ApiResponse, SelectableCatalogsDto, InsurerDto } from '../../shared/types';
import { completionMoney } from './RenewalPolicySelector';

export interface VersionPayload {
  insurerId: string;
  productId: string;
  branchId: string;
  paymentMethodId: string;
  startDate: string;
  endDate: string;
  validUntil: string;
  grossPremiumMinor: number;
  currency: string;
  installmentCount: number | null;
  termsSummary: string | null;
}
export interface SavedQuoteVersion {
  id: string;
  version_number: number;
  insurer_id?: string;
  product_id: string;
  product_name: string;
  gross_premium_minor: number;
  currency: string;
  branch_id?: string;
  payment_method_id?: string;
  start_date?: string;
  end_date?: string;
  valid_until?: string;
  installment_count?: number | null;
  terms_summary?: string | null;
}
interface SavedQuote {
  versionCount?: number;
  id: string;
  status: string;
  current_version_id: string;
  versions: SavedQuoteVersion[];
}

function decimal(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) return '';
  const value = BigInt(minor);
  return `${value / 100n},${String(value % 100n).padStart(2, '0')}`;
}
function parsePremium(text: string): number | null {
  const canonical = text.trim().replace(',', '.');
  if (!/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(canonical)) return null;
  const [whole, fraction = ''] = canonical.split('.');
  const value = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}
const normalize = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
function preferredInsurer(insurers: readonly InsurerDto[]): InsurerDto | undefined {
  const byCode = insurers.filter((item) =>
    ['ANADOLU', 'ANADOLUSIGORTA'].includes(normalize(item.code)),
  );
  if (byCode.length === 1) return byCode[0];
  const byName = insurers.filter((item) => normalize(item.name) === 'ANADOLUSIGORTA');
  return byName.length === 1 ? byName[0] : undefined;
}
async function read<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error('CATALOG_UNAVAILABLE');
  const envelope = (await response.json()) as ApiResponse<T>;
  if (!envelope.success) throw new Error('CATALOG_UNAVAILABLE');
  return envelope.data;
}
function seed(defaults: VersionPayload, current?: SavedQuoteVersion): VersionPayload {
  if (!current?.insurer_id) return defaults;
  return {
    ...defaults,
    insurerId: current.insurer_id,
    productId: current.product_id,
    branchId: current.branch_id ?? defaults.branchId,
    paymentMethodId: current.payment_method_id ?? defaults.paymentMethodId,
    startDate: current.start_date ?? defaults.startDate,
    endDate: current.end_date ?? defaults.endDate,
    validUntil: defaults.validUntil,
    grossPremiumMinor: current.gross_premium_minor,
    currency: current.currency,
    installmentCount:
      current.installment_count === undefined
        ? defaults.installmentCount
        : current.installment_count,
    termsSummary:
      current.terms_summary === undefined ? defaults.termsSummary : current.terms_summary,
  };
}

export function RenewalQuoteForm({
  defaults,
  quotes,
  currentQuoteId,
  currentStatus,
  customerName,
  busy,
  onCreate,
  onVersion,
}: {
  readonly defaults: VersionPayload;
  readonly quotes: SavedQuote[];
  readonly currentQuoteId?: string;
  readonly currentStatus?: string;
  readonly customerName: string;
  readonly busy: boolean;
  readonly onCreate: (version: VersionPayload) => Promise<void>;
  readonly onVersion: (version: VersionPayload) => Promise<void>;
}) {
  const currentQuote = quotes.find((quote) => quote.id === currentQuoteId);
  const current = currentQuote?.versions.find(
    (version) => version.id === currentQuote.current_version_id,
  );
  const [initial] = useState(() => seed(defaults, current));
  const [insurerId, setInsurerId] = useState(initial.insurerId);
  const [productId, setProductId] = useState(initial.productId);
  const [premium, setPremium] = useState(() => decimal(initial.grossPremiumMinor));
  const [confirmed, setConfirmed] = useState(false);
  const [catalogs, setCatalogs] = useState<SelectableCatalogsDto | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const insurerKeys = JSON.stringify(
    [
      ...new Set(
        [
          defaults.insurerId,
          ...quotes.flatMap((quote) => quote.versions.map((version) => version.insurer_id)),
        ].filter((id): id is string => Boolean(id)),
      ),
    ].sort(),
  );

  useEffect(() => {
    let active = true;
    setCatalogLoading(true);
    setCatalogError('');
    void (async () => {
      try {
        const data = await fetch('/api/catalogs/selectable', { cache: 'no-store' }).then(
          read<SelectableCatalogsDto>,
        );
        if (
          ![data.insurers, data.products, data.branches, data.paymentMethods].every(Array.isArray)
        )
          throw new Error();
        const labels: Record<string, string> = {};
        for (const insurer of data.insurers) labels[`insurer:${insurer.id}`] = insurer.name;
        for (const product of data.products) labels[`product:${product.id}`] = product.name;
        if (!active) return;
        setCatalogs(data);
        const ids = JSON.parse(insurerKeys) as string[];
        const missing = ids
          .filter((id) => !labels[`insurer:${id}`])
          .map((id) => ({ type: 'insurer', id }));
        if (defaults.productId && !labels[`product:${defaults.productId}`])
          missing.push({ type: 'product', id: defaults.productId });
        await Promise.all(
          missing.map(async ({ type, id }) => {
            try {
              const item = await fetch(`/api/catalogs/resolve/${type}/${encodeURIComponent(id)}`, {
                cache: 'no-store',
              }).then(read<{ id: string; name: string }>);
              if (item.id === id && typeof item.name === 'string')
                labels[`${type}:${id}`] = item.name;
            } catch {
              /* Historical labels may be unavailable; never show a raw ID. */
            }
          }),
        );
        if (active) setNames(labels);
      } catch {
        if (active) {
          setCatalogs(null);
          setNames({});
          setCatalogError('Teklif katalogları yüklenemedi veya erişilemiyor.');
        }
      } finally {
        if (active) setCatalogLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [refresh, insurerKeys, defaults.productId]);

  const branches =
    catalogs?.branches.filter(
      (branch) => branch.status === 'ACTIVE' && branch.id === defaults.branchId,
    ) ?? [];
  const eligibleProducts =
    catalogs?.products.filter(
      (product) =>
        product.status === 'ACTIVE' &&
        product.branchId === defaults.branchId &&
        branches.some(
          (branch) => branch.id === product.branchId && branch.agencyId === product.agencyId,
        ),
    ) ?? [];
  const insurers =
    catalogs?.insurers.filter(
      (insurer) =>
        insurer.status === 'ACTIVE' &&
        eligibleProducts.some(
          (product) => product.insurerId === insurer.id && product.agencyId === insurer.agencyId,
        ),
    ) ?? [];
  const preferred = preferredInsurer(insurers);
  const orderedInsurers = preferred
    ? [preferred, ...insurers.filter((insurer) => insurer.id !== preferred.id)]
    : insurers;
  const selectedInsurer = insurers.find((insurer) => insurer.id === insurerId);
  const products = eligibleProducts.filter(
    (product) => product.insurerId === insurerId && product.agencyId === selectedInsurer?.agencyId,
  );
  const product = products.find((item) => item.id === productId);
  const switched = insurerId !== initial.insurerId;
  const payment = catalogs?.paymentMethods.find(
    (item) => item.id === initial.paymentMethodId && item.status === 'ACTIVE',
  );
  const paymentValid =
    payment &&
    (initial.installmentCount === null ||
      (payment.supportsInstallments && initial.installmentCount <= payment.maxInstallments));
  const valid = Boolean(
    selectedInsurer && product && paymentValid && !catalogLoading && !catalogError,
  );
  const sameOffer =
    !current ||
    ((current.insurer_id ?? defaults.insurerId) === insurerId && current.product_id === productId);

  function selectInsurer(id: string) {
    if (id === insurerId) return;
    setInsurerId(id);
    setProductId('');
    setPremium('');
    setConfirmed(false);
    setError('');
  }
  function submit(kind: 'CREATE' | 'VERSION') {
    if (busy || !valid) {
      setError('Aktif ve uyumlu şirket, ürün ve ödeme bilgileri gereklidir.');
      return;
    }
    const amount = parsePremium(premium);
    if (amount === null) {
      setError('Primi en fazla iki ondalık basamakla girin (örnek: 1250,50).');
      return;
    }
    if (switched && !confirmed) {
      setError('Yeni şirket, ürün ve prim bilgilerini kontrol edip onaylayın.');
      return;
    }
    if (kind === 'VERSION' && (!sameOffer || currentStatus === 'ACCEPTED')) {
      setError('Farklı şirket veya ürün için ayrı teklif oluşturun.');
      return;
    }
    setError('');
    const payload = {
      ...initial,
      insurerId,
      productId,
      branchId: product!.branchId,
      grossPremiumMinor: amount,
    };
    void (kind === 'CREATE' ? onCreate(payload) : onVersion(payload));
  }

  return (
    <section aria-label="Yenileme teklifi hazırlama">
      <h4>Yenileme teklifi</h4>
      <p>
        Mevcut poliçe: {names[`insurer:${defaults.insurerId}`] ?? 'Şirket bilgisi alınamadı'} ·{' '}
        {names[`product:${defaults.productId}`] ?? 'Ürün bilgisi alınamadı'}
      </p>
      {catalogLoading && <p role="status">Teklif katalogları yükleniyor…</p>}
      {catalogError && <p role="alert">{catalogError}</p>}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit(
            currentQuoteId && sameOffer && currentStatus !== 'ACCEPTED' ? 'VERSION' : 'CREATE',
          );
        }}
      >
        <fieldset
          disabled={busy || catalogLoading || Boolean(catalogError)}
          style={{ border: 0, padding: 0, display: 'grid', gap: '0.5rem' }}
        >
          {preferred && preferred.id !== insurerId && (
            <button type="button" onClick={() => selectInsurer(preferred.id)}>
              Anadolu Sigorta ile teklif hazırla
            </button>
          )}
          <label>
            Teklif şirketi: {customerName}
            <select
              value={selectedInsurer ? insurerId : ''}
              onChange={(event) => selectInsurer(event.target.value)}
              required
            >
              <option value="">Şirket seçin</option>
              {orderedInsurers.map((insurer) => (
                <option key={insurer.id} value={insurer.id}>
                  {insurer.name}
                  {insurer.id === preferred?.id ? ' — Tercih edilen' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Teklif ürünü: {customerName}
            <select
              value={product ? productId : ''}
              onChange={(event) => {
                setProductId(event.target.value);
                setConfirmed(false);
              }}
              required
            >
              <option value="">Ürün seçin</option>
              {products.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Teklif primi ({initial.currency}): {customerName}
            <input
              inputMode="decimal"
              value={premium}
              maxLength={32}
              onChange={(event) => {
                setPremium(event.target.value);
                setConfirmed(false);
              }}
              required
            />
          </label>
          <p>
            Dönem: {initial.startDate} – {initial.endDate} · Para birimi: {initial.currency} ·
            Ödeme: {payment?.name ?? 'Geçerli ödeme yöntemi bulunamadı'}
          </p>
          {!selectedInsurer || !product ? (
            <p>Mevcut seçim aktif ve uyumlu değilse şirketi ve ürünü açıkça seçin.</p>
          ) : null}
          {switched && (
            <>
              <p>
                Şirket değişti. Ürün ve primi eski poliçeden taşımadık; yeni teklifi kontrol edin.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Yeni şirket, ürün ve prim bilgilerini kontrol ettim.
              </label>
            </>
          )}
          {currentQuoteId && !sameOffer && (
            <p>
              Farklı şirket veya ürün ayrı teklif olarak kaydedilir; önceki teklif ve sürümleri
              korunur.
            </p>
          )}
          <button type="submit" disabled={!valid}>
            {currentQuoteId
              ? sameOffer && currentStatus !== 'ACCEPTED'
                ? 'Yeni teklif sürümü oluştur'
                : 'Ayrı teklif oluştur'
              : 'Teklif oluştur'}
            : {customerName}
          </button>
          {currentQuoteId && sameOffer && currentStatus !== 'ACCEPTED' && (
            <button type="button" disabled={!valid} onClick={() => submit('CREATE')}>
              Ayrı teklif oluştur: {customerName}
            </button>
          )}
        </fieldset>
        {error && <p role="alert">{error}</p>}
      </form>
      <button
        type="button"
        disabled={catalogLoading || busy}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Teklif kataloglarını yenile
      </button>
      {quotes.map((quote) => (
        <div key={quote.id}>
          <p>
            {quote.status} · {quote.versionCount ?? quote.versions.length} değiştirilemeyen sürüm
          </p>
          {quote.versionCount && quote.versionCount > quote.versions.length ? (
            <p>Bu özette ilk, güncel ve kabul edilen fiyatlar gösterilir.</p>
          ) : null}
          <ul>
            {quote.versions.map((version) => (
              <li key={version.id}>
                Sigorta şirketi:{' '}
                {names[`insurer:${version.insurer_id ?? ''}`] ?? 'Şirket bilgisi alınamadı'} · Ürün:{' '}
                {version.product_name} · v{version.version_number}:{' '}
                {completionMoney(version.gross_premium_minor, version.currency)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

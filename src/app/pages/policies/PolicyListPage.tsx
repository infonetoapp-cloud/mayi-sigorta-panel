import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Eye,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type {
  PolicyDto,
  PolicyDetailDto,
  PolicyListResponseData,
  InsurerDto,
  CustomerListResponseData,
} from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useCustomerResource } from '../customers/customer-resource';
import { policyDate, policyMoney, policyStatusLabel, PolicyReadNotice } from './policy-display';
import {
  portfolioDefaults as defaults,
  portfolioFilters as filters,
  expirationRange,
  type PortfolioFilters,
} from './policy-portfolio';
import './portfolio-v4.css';
import {
  AuthorizedCustomerNames,
  AuthorizedCustomerName as CustomerName,
} from './AuthorizedCustomerNames';
export function expirationLabel(end: string) {
  const today = expirationRange(1).endFrom;
  const days = Math.round(
    (Date.parse(end + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000,
  );
  return !Number.isFinite(days)
    ? 'Tarih kontrolü'
    : days === 0
      ? 'Bugün bitiyor'
      : days < 0
        ? `${Math.abs(days)} gün önce sona erdi`
        : `${days} gün kaldı`;
}
function CustomerFilter({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  return (
    <section className="pv4-customer-search" aria-label="Sunucuda müşteri seçimi">
      <label htmlFor="portfolio-customer-search">Müşteri adıyla ara</label>
      <div className="pv4-inline">
        <Input
          id="portfolio-customer-search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={100}
          placeholder="Ad veya şirket unvanı"
        />
        <Button
          variant="outline"
          onClick={() => {
            setCursor(null);
            setQuery(text.trim());
          }}
        >
          Müşterileri sunucuda ara
        </Button>
      </div>
      <p>
        Yetkili müşteriler sunucuda aranır. Sonuçtan bir müşteri seçin; tüm portföy tarayıcıya
        indirilmez.
      </p>
      {selected && (
        <div className="pv4-inline">
          <CustomerName key={selected} id={selected} state={null} />
          <Button variant="ghost" onClick={() => onSelect('')}>
            Müşteri seçimini kaldır
          </Button>
        </div>
      )}
      {query !== null && (
        <CustomerOptions
          key={query + '|' + cursor}
          query={query}
          cursor={cursor}
          next={setCursor}
          select={onSelect}
          selected={selected}
        />
      )}
    </section>
  );
}
function CustomerOptions({
  query,
  cursor,
  next,
  select,
  selected,
}: {
  query: string;
  cursor: string | null;
  next: (c: string | null) => void;
  select: (id: string) => void;
  selected: string;
}) {
  const params = new URLSearchParams({ limit: '20' });
  if (query) params.set('search', query);
  if (cursor) params.set('cursor', cursor);
  const r = useCustomerResource<CustomerListResponseData>('/api/customers?' + params);
  return (
    <>
      {r.loading && <p role="status">Müşteriler sunucuda aranıyor…</p>}
      {r.error && (
        <div role="alert">
          <p>{r.error.message}</p>
          {r.error.status >= 500 && (
            <Button variant="outline" onClick={r.reload}>
              Müşteri aramasını yeniden dene
            </Button>
          )}
        </div>
      )}
      {r.data && (
        <>
          <div className="pv4-customer-options">
            {r.data.items.map((c) => (
              <Button
                key={c.id}
                variant={selected === c.id ? 'default' : 'outline'}
                aria-pressed={selected === c.id}
                onClick={() => select(c.id)}
              >
                {c.displayName}
              </Button>
            ))}
          </div>
          {!r.data.items.length && <p>Görüntülenebilir eşleşen müşteri yok.</p>}
          <div className="pv4-inline">
            <Button variant="ghost" disabled={!cursor || r.loading} onClick={() => next(null)}>
              İlk müşteriler
            </Button>
            <Button
              variant="outline"
              disabled={!r.data.hasMore || !r.data.nextCursor || r.loading}
              onClick={() => next(r.data!.nextCursor)}
            >
              Sonraki müşteriler
            </Button>
          </div>
        </>
      )}
    </>
  );
}
function PolicyPreview({
  id,
  returnState,
  onClose,
}: {
  id: string;
  returnState: unknown;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const r = useCustomerResource<PolicyDetailDto>(`/api/policies/${encodeURIComponent(id)}`);
  const p = r.data?.id === id ? r.data : undefined;
  useEffect(() => {
    const d = ref.current;
    d?.showModal?.();
    return () => d?.close?.();
  }, []);
  return (
    <dialog
      ref={ref}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function' ? true : undefined}
      className="pv4-preview"
      aria-label="Poliçe önizlemesi"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="pv4-preview-head">
        <span>POLİÇE ÖNİZLEMESİ</span>
        <Button variant="ghost" onClick={onClose} aria-label="Önizlemeyi kapat">
          <X size={18} aria-hidden="true" />
        </Button>
      </div>
      <PolicyReadNotice {...r} />
      {p && (
        <>
          <h2>{p.policyNumber}</h2>
          <Link
            className="pv4-preview-customer"
            to={`/customers/${encodeURIComponent(p.customer.id)}`}
            state={returnState}
          >
            {p.customer.displayName}
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
          <div className="pv4-badges">
            <span>{policyStatusLabel[p.status]}</span>
            <span>{p.archivedAt ? 'Arşivlenmiş' : 'Arşiv dışı'}</span>
          </div>
          <dl>
            <div>
              <dt>Sigorta</dt>
              <dd>
                {p.product.name}
                <small>
                  {p.insurer.name} · {p.branch.name}
                </small>
              </dd>
            </div>
            <div>
              <dt>Sözleşme dönemi</dt>
              <dd>
                {policyDate(p.startDate)} – {policyDate(p.endDate)}
              </dd>
            </div>
            <div>
              <dt>Vade</dt>
              <dd>{expirationLabel(p.endDate)}</dd>
            </div>
            <div>
              <dt>Brüt poliçe primi</dt>
              <dd>
                {policyMoney(p.grossPremiumMinor, p.currency)}
                <small>Tahsilat veya gelir değildir.</small>
              </dd>
            </div>
            <div>
              <dt>Ödeme yöntemi</dt>
              <dd>{p.paymentMethod.name}</dd>
            </div>
          </dl>
          <div className="pv4-preview-actions">
            <Button asChild>
              <Link
                to={`/policies/${encodeURIComponent(p.id)}?section=renewal`}
                state={returnState}
              >
                Yenileme ve teklifler
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={`/policies/${encodeURIComponent(p.id)}`} state={returnState}>
                Poliçe ayrıntısını aç
              </Link>
            </Button>
          </div>
        </>
      )}
    </dialog>
  );
}
export default function PolicyListPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const signature = params.toString();
  const [draft, setDraft] = useState(() => filters(params));
  const [validation, setValidation] = useState('');
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    setDraft(filters(new URLSearchParams(signature)));
    setValidation('');
  }, [signature]);
  const selected = params.get('preview');
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const lastPreview = useRef(selected);
  useEffect(() => {
    if (lastPreview.current && !selected) {
      const target = previewTrigger.current?.isConnected
        ? previewTrigger.current
        : document.getElementById('policy-search');
      target?.focus();
    }
    lastPreview.current = selected;
  }, [selected]);
  const returnState = {
    ...location.state,
    policyListReturn: '/policies' + (signature ? '?' + signature : ''),
  };
  const query = new URLSearchParams({ pageSize: '20', includeLabels: 'true' });
  for (const [k, v] of Object.entries(filters(params))) if (v) query.set(k, v);
  const cursor = params.get('cursor');
  if (cursor) query.set('cursor', cursor);
  const state = useCustomerResource<PolicyListResponseData>('/api/policies?' + query);
  const insurers = useCustomerResource<InsurerDto[]>(
    '/api/catalogs/insurers?include_inactive=true',
  );
  const options = Array.isArray(insurers.data) ? insurers.data : [];
  function apply(values: PortfolioFilters) {
    if (values.endFrom && values.endTo && values.endFrom > values.endTo) {
      setValidation('Bitiş başlangıcı, bitiş sonundan sonra olamaz.');
      return;
    }
    setValidation('');
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) if (v.trim()) next.set(k, v.trim());
    setParams(next);
    if (next.toString() === signature) state.reload();
  }
  function closePreview() {
    const next = new URLSearchParams(params);
    next.delete('preview');
    setParams(next, { replace: true, state: location.state });
  }
  const field = (key: 'search' | 'endFrom' | 'endTo', label: string, type = 'text') => (
    <div>
      <label htmlFor={'policy-' + key}>{label}</label>
      <Input
        id={'policy-' + key}
        type={type}
        maxLength={key === 'search' ? 100 : undefined}
        value={draft[key]}
        placeholder={key === 'search' ? 'Poliçe numarasını yazın' : undefined}
        onChange={(e) => setDraft((p) => ({ ...p, [key]: e.target.value }))}
      />
    </div>
  );
  const select = (
    key: 'searchMode' | 'status' | 'insurerId' | 'sort',
    label: string,
    values: [string, string][],
  ) => (
    <div>
      <label htmlFor={'policy-' + key}>{label}</label>
      <select
        id={'policy-' + key}
        value={draft[key]}
        onChange={(e) => setDraft((p) => ({ ...p, [key]: e.target.value }))}
      >
        {key === 'insurerId' &&
          draft.insurerId &&
          !options.some((o) => o.id === draft.insurerId) && (
            <option value={draft.insurerId}>Seçili sigortacı (etiketi kullanılamıyor)</option>
          )}
        {values.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
  const active = Object.entries(filters(params)).filter(
    ([k, v]) => v && v !== defaults[k as keyof PortfolioFilters],
  );
  const names: Record<string, string> = {
    search: 'Numara',
    searchMode: 'Eşleştirme',
    insurerId: 'Sigortacı',
    status: 'Durum',
    endFrom: 'Bitiş ≥',
    endTo: 'Bitiş ≤',
    sort: 'Sıralama',
    customerId: 'Müşteri',
  };
  return (
    <div className="customer-modern policy-modern portfolio-v4" data-filters-open={advanced}>
      <header className="pv4-page-header">
        <div>
          <span className="pv4-eyebrow">SÖZLEŞME VE YENİLEME</span>
          <h1>Poliçe portföyü</h1>
        </div>
        <div className="pv4-inline">
          <Button asChild>
            <Link to="/policies/new" state={returnState}>
              <Plus size={17} aria-hidden="true" />
              Yeni poliçe
            </Link>
          </Button>
        </div>
      </header>
      <section className="pv4-surface" aria-label="Poliçe portföyü">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply(draft);
          }}
          className="pv4-toolbar"
        >
          {field('search', 'Poliçe numarası')}
          <div id="portfolio-query-options" className="pv4-query-options">
            {select('searchMode', 'Eşleştirme', [
              ['exact', 'Tam numara'],
              ['prefix', 'Numara başlangıcı'],
            ])}
            {select('sort', 'Sıralama', [
              ['end_date_asc', 'Bitiş tarihi — önce yakın'],
              ['end_date_desc', 'Bitiş tarihi — önce uzak'],
              ['created_at_desc', 'En yeni kayıt'],
            ])}
          </div>
          <Button type="submit" className="pv4-apply">
            Filtrele
          </Button>
          <Button
            variant="outline"
            aria-expanded={advanced}
            aria-controls="portfolio-advanced portfolio-query-options portfolio-expiry"
            aria-label="Gelişmiş filtreler"
            onClick={() => setAdvanced(!advanced)}
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
            Filtreler ve sıralama{active.length ? ` (${active.length})` : ''}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setParams({});
              setDraft(defaults);
              setValidation('');
              if (!signature) state.reload();
            }}
          >
            Temizle
          </Button>
        </form>
        <div id="portfolio-advanced" hidden={!advanced} className="pv4-advanced">
          <div className="pv4-filter-grid">
            {select('status', 'Poliçe durumu', [
              ['', 'Tüm durumlar'],
              ['ACTIVE', 'Aktif'],
              ['CANCELLED', 'İptal'],
              ['VOIDED', 'Geçersiz'],
            ])}
            {select('insurerId', 'Sigortacı', [
              ['', 'Tüm sigortacılar'],
              ...options.map(
                (o) =>
                  [o.id, o.name + (o.status === 'INACTIVE' ? ' (Pasif)' : '')] as [string, string],
              ),
            ])}
            {field('endFrom', 'Bitiş başlangıcı', 'date')}
            {field('endTo', 'Bitiş sonu', 'date')}
          </div>
          <CustomerFilter
            selected={draft.customerId}
            onSelect={(customerId) => setDraft((p) => ({ ...p, customerId }))}
          />
          <Button onClick={() => apply(draft)}>Gelişmiş filtreleri uygula</Button>
        </div>
        <div
          id="portfolio-expiry"
          className="pv4-expiry"
          role="group"
          aria-label="Vade kısayolları"
        >
          <span>Vade</span>
          {[1, 3, 7, 15, 30, 'past' as const].map((days) => {
            const range = expirationRange(days);
            return (
              <Button
                key={days}
                variant="ghost"
                aria-pressed={
                  (params.get('endFrom') ?? '') === range.endFrom &&
                  params.get('endTo') === range.endTo
                }
                onClick={() => apply({ ...filters(params), ...expirationRange(days) })}
              >
                {days === 'past' ? 'Vadesi geçmiş' : days === 1 ? 'Bugün' : days + ' gün'}
              </Button>
            );
          })}
          <span className="pv4-scope">İstanbul takvimi · Günler dahil</span>
        </div>
        {!!active.length && (
          <div className="pv4-active-filters" role="region" aria-label="Etkin filtreler">
            {active.map(([key, value]) => (
              <button
                key={key}
                aria-label={names[key] + ' filtresini kaldır'}
                onClick={() =>
                  apply({ ...filters(params), [key]: defaults[key as keyof PortfolioFilters] })
                }
              >
                {names[key]}:{' '}
                {key === 'insurerId'
                  ? (options.find((o) => o.id === value)?.name ?? 'Seçili sigortacı')
                  : key === 'customerId'
                    ? 'Seçili müşteri'
                    : key === 'searchMode'
                      ? value === 'prefix'
                        ? 'Başlangıç'
                        : 'Tam numara'
                      : key === 'status'
                        ? policyStatusLabel[value as keyof typeof policyStatusLabel]
                        : key === 'sort'
                          ? value === 'end_date_desc'
                            ? 'Önce uzak vade'
                            : 'En yeni kayıt'
                          : value}
                <X size={12} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        <div className="pv4-list-heading">
          <h2>
            Sözleşmeler <span>{state.data ? state.data.items.length + ' bu sayfada' : '…'}</span>
          </h2>
          <span>Brüt primler · kendi para biriminde</span>
        </div>
        {validation && <p role="alert">{validation}</p>}
        {insurers.error && (
          <div role="alert" className="pv4-warning">
            Sigortacı seçenekleri yüklenemedi. Poliçe listesini kullanmaya devam edebilirsiniz.
            <Button variant="ghost" onClick={insurers.reload}>
              Sigortacıları yeniden yükle
            </Button>
          </div>
        )}
        <PolicyReadNotice {...state} />
        {state.data && !state.data.items.length && (
          <div className="pv4-empty">
            <ShieldCheck size={30} aria-hidden="true" />
            <h2>Poliçe bulunamadı</h2>
            <p>
              Yetkili kayıtlarda filtre eşleşmesi yok. Bu sonuç acentenin tüm portföyünün boş
              olduğunu göstermez.
            </p>
            <Button variant="outline" onClick={() => apply(defaults)}>
              Filtreleri temizle
            </Button>
          </div>
        )}
        {state.data && !!state.data.items.length && (
          <AuthorizedCustomerNames ids={state.data.items.map((p) => p.customerId)}>
            <table className="pv4-table">
              <caption className="sr-only">Yetkili poliçe listesi</caption>
              <thead>
                <tr>
                  <th>Müşteri / poliçe</th>
                  <th>Sigorta</th>
                  <th>Sözleşme dönemi / vade</th>
                  <th className="pv4-number">Brüt prim</th>
                  <th>Durum</th>
                  <th>İşlem</th>
                </tr>
              </thead>
              <tbody>
                {state.data.items.map((p: PolicyDto) => (
                  <tr key={p.id} data-selected={selected === p.id}>
                    <td>
                      <CustomerName key={p.customerId} id={p.customerId} state={returnState} />
                      <Link
                        className="pv4-policy-link"
                        to={'/policies/' + encodeURIComponent(p.id)}
                        state={returnState}
                      >
                        {p.policyNumber}
                      </Link>
                    </td>
                    <td>
                      {p.labels ? (
                        <>
                          <strong>{p.labels.productName}</strong>
                          <small>{p.labels.insurerName}</small>
                          <small>{p.labels.branchName}</small>
                        </>
                      ) : (
                        <span>Sigortacı / ürün / branş bilgisi kullanılamıyor</span>
                      )}
                    </td>
                    <td>
                      <span>{policyDate(p.startDate)} –</span>
                      <strong>{policyDate(p.endDate)}</strong>
                      <small className="pv4-expiration">{expirationLabel(p.endDate)}</small>
                    </td>
                    <td className="pv4-number">{policyMoney(p.grossPremiumMinor, p.currency)}</td>
                    <td>
                      <span className={'pv4-status ' + (p.status === 'ACTIVE' ? 'is-active' : '')}>
                        {policyStatusLabel[p.status]}
                      </span>
                      <small>{p.archivedAt ? 'Arşivlenmiş' : 'Arşiv dışı'}</small>
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={p.policyNumber + ' önizle'}
                        onClick={(event) => {
                          previewTrigger.current = event.currentTarget;
                          const next = new URLSearchParams(params);
                          next.set('preview', p.id);
                          setParams(next, { state: location.state });
                        }}
                      >
                        <Eye size={16} aria-hidden="true" />
                        <span>Önizle</span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </AuthorizedCustomerNames>
        )}
        <footer className="pv4-pagination">
          <span>Sunucuda arama ve sıralama · En fazla 20 kayıt / sayfa</span>
          <Button
            variant="outline"
            disabled={state.loading || !cursor}
            onClick={() => {
              const n = new URLSearchParams(params);
              n.delete('cursor');
              n.delete('preview');
              setParams(n);
            }}
          >
            <ChevronLeft size={15} aria-hidden="true" />
            İlk sayfa
          </Button>
          <Button
            variant="outline"
            disabled={state.loading || !state.data?.hasMore || !state.data.nextCursor}
            onClick={() => {
              if (state.data?.nextCursor) {
                const n = new URLSearchParams(params);
                n.set('cursor', state.data.nextCursor);
                n.delete('preview');
                setParams(n);
              }
            }}
          >
            Sonraki sayfa
            <ChevronRight size={15} aria-hidden="true" />
          </Button>
        </footer>
      </section>
      <p className="pv4-footnote">
        Arama numarada tam eşleşme veya başlangıç eşleşmesidir. Müşteri adına göre sunucu araması
        gelişmiş filtrelerdedir. Kayıt durumu, sözleşme vadesi ve tahsilat birbirinden farklıdır.
      </p>
      {selected && (
        <PolicyPreview
          key={selected}
          id={selected}
          returnState={returnState}
          onClose={closePreview}
        />
      )}
    </div>
  );
}

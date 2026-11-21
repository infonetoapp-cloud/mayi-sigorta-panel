import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';
import { useCustomerResource } from '../customers/customer-resource';
import { useListReturn } from '../../components/layout/use-list-return';
import { policyListReadSchema } from './policy-read-schemas';
import {
  storedPolicyDate,
  policyMoney,
  policyStatusLabel,
  PolicyPeriodBadge,
  PolicyReadNotice,
} from './policy-display';
const defaults = {
  search: '',
  searchMode: 'exact',
  status: 'ACTIVE',
  endFrom: '',
  endTo: '',
  sort: 'end_date_asc',
};
const viewLabels: Record<string, string> = {
  ACTIVE: 'Aktif kayıtlar',
  CANCELLED: 'İptal edilenler',
  VOIDED: 'Geçersiz kayıtlar',
  ALL: 'Tümü',
};
function filters(params: URLSearchParams) {
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [key, params.get(key) ?? fallback]),
  ) as typeof defaults;
}
function requestUrl(params: URLSearchParams) {
  const query = new URLSearchParams({ pageSize: '20', includeLabels: 'true' });
  for (const [key, value] of Object.entries(filters(params)))
    if (value && !(key === 'status' && value === 'ALL')) query.set(key, value);
  const cursor = params.get('cursor');
  if (cursor) query.set('cursor', cursor);
  return `/api/policies?${query}`;
}
export default function PolicyListPage() {
  const [params, setParams] = useSearchParams();
  const applied = filters(params);
  const signature = params.toString();
  const [draft, setDraft] = useState(() => filters(params));
  const [validation, setValidation] = useState('');
  useEffect(() => {
    setDraft(filters(new URLSearchParams(signature)));
    setValidation('');
  }, [signature]);
  const cursor = params.get('cursor');
  const url = requestUrl(params);
  const state = useCustomerResource(url, policyListReadSchema);
  const { page, tableRegion, advanced, rememberPosition, listUrl, listPositionKey } = useListReturn(
    !!state.data,
  );
  function apply(next: URLSearchParams) {
    setParams(next);
    if (requestUrl(next) === url) state.reload();
  }
  function changeView(status: string) {
    const next = new URLSearchParams(params);
    next.set('status', status);
    next.delete('cursor');
    apply(next);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.endFrom && draft.endTo && draft.endFrom > draft.endTo) {
      setValidation('Bitiş başlangıcı, bitiş sonundan sonra olamaz.');
      return;
    }
    setValidation('');
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(draft)) if (value.trim()) next.set(key, value.trim());
    apply(next);
  }
  const input = (key: 'search' | 'endFrom' | 'endTo', label: string, type = 'text') => (
    <div>
      <label htmlFor={`policy-${key}`}>{label}</label>
      <Input
        id={`policy-${key}`}
        type={type}
        maxLength={key === 'search' ? 100 : undefined}
        value={draft[key]}
        onChange={(event) => setDraft((previous) => ({ ...previous, [key]: event.target.value }))}
      />
    </div>
  );
  return (
    <div className="customer-modern policy-modern" ref={page}>
      <PageHeader
        title="Poliçeler"
        description="Acente poliçelerini ve yetkili olduğunuz tarihsel kayıtları inceleyin."
        action={
          <div className="customer-form-actions">
            <Button asChild>
              <Link to="/policies/new">Yeni poliçe</Link>
            </Button>
          </div>
        }
      />
      <div className="policy-list-views" role="group" aria-label="Poliçe görünümü">
        {(
          [
            ['ACTIVE', 'Aktif kayıtlar'],
            ['CANCELLED', 'İptal edilenler'],
            ['ALL', 'Tümü'],
          ] as const
        ).map(([status, label]) => (
          <Button
            key={status}
            variant="outline"
            aria-pressed={applied.status === status}
            onClick={() => changeView(status)}
          >
            {label}
          </Button>
        ))}
      </div>
      <Card className="customer-list-card">
        <form
          className="policy-filters customer-form-grid"
          onSubmit={submit}
          aria-label="Poliçe filtreleri"
        >
          {input('search', 'Poliçe numarası')}
          <div className="customer-form-actions">
            <Button type="submit">Filtrele</Button>
            <Button
              variant="ghost"
              onClick={() => {
                apply(new URLSearchParams());
                setDraft(defaults);
                setValidation('');
              }}
            >
              Temizle
            </Button>
          </div>
          <details className="policy-advanced-filters" ref={advanced}>
            <summary>Tarih ve diğer filtreler</summary>
            <div className="customer-form-grid">
              <div>
                <label htmlFor="policy-searchMode">Eşleştirme</label>
                <select
                  id="policy-searchMode"
                  value={draft.searchMode}
                  onChange={(event) =>
                    setDraft((previous) => ({ ...previous, searchMode: event.target.value }))
                  }
                >
                  <option value="exact">Tam numara</option>
                  <option value="prefix">Numara başlangıcı</option>
                </select>
              </div>
              <div>
                <label htmlFor="policy-status">Poliçe durumu</label>
                <select
                  id="policy-status"
                  value={draft.status}
                  onChange={(event) =>
                    setDraft((previous) => ({ ...previous, status: event.target.value }))
                  }
                >
                  <option value="ALL">Tüm durumlar</option>
                  <option value="ACTIVE">Aktif</option>
                  <option value="CANCELLED">İptal</option>
                  <option value="VOIDED">Geçersiz</option>
                </select>
              </div>
              {input('endFrom', 'Bitiş başlangıcı', 'date')}
              {input('endTo', 'Bitiş sonu', 'date')}
              <div>
                <label htmlFor="policy-sort">Sıralama</label>
                <select
                  id="policy-sort"
                  value={draft.sort}
                  onChange={(event) =>
                    setDraft((previous) => ({ ...previous, sort: event.target.value }))
                  }
                >
                  <option value="end_date_asc">Bitiş tarihi — önce yakın</option>
                  <option value="end_date_desc">Bitiş tarihi — önce uzak</option>
                  <option value="created_at_desc">En yeni kayıt</option>
                </select>
              </div>
            </div>
          </details>
        </form>
        {validation && <p role="alert">{validation}</p>}
        <PolicyReadNotice {...state} />
        {state.data && !state.data.items.length && (
          <div className="customer-state">
            <h2>Poliçe bulunamadı</h2>
            <p>
              Aranan görünüm <strong>{viewLabels[applied.status] ?? 'Seçili filtreler'}</strong>.
            </p>
            {!state.loading &&
              applied.status === 'ACTIVE' &&
              applied.searchMode === 'exact' &&
              applied.search.trim() && (
                <Button variant="outline" onClick={() => changeView('CANCELLED')}>
                  İptal edilenlerde ara
                </Button>
              )}
          </div>
        )}
        {state.data && !!state.data.items.length && (
          <div
            className="policy-directory-region"
            ref={tableRegion}
            role="region"
            aria-label="Poliçe listesi"
            tabIndex={0}
          >
            <table className="policy-directory-table">
              <caption className="sr-only">
                Müşteri, ürün ve şirket bilgileriyle yetkili poliçeler
              </caption>
              <thead>
                <tr>
                  <th scope="col">Müşteri / Ünvan</th>
                  <th scope="col">Poliçe no</th>
                  <th scope="col">Ürün / Branş</th>
                  <th scope="col">Sigorta şirketi</th>
                  <th scope="col">Poliçe dönemi</th>
                  <th scope="col">Prim</th>
                  <th scope="col">Durum</th>
                </tr>
              </thead>
              <tbody>
                {state.data.items.map((policy) => (
                  <tr key={policy.id}>
                    <td data-label="Müşteri / Ünvan">
                      {policy.labels?.customerDisplayName ? (
                        <Link
                          className="customer-name"
                          to={`/customers/${encodeURIComponent(policy.customerId)}`}
                        >
                          {policy.labels.customerDisplayName}
                        </Link>
                      ) : (
                        <span className="policy-list-muted">Müşteri bilgisi kullanılamıyor</span>
                      )}
                    </td>
                    <td data-label="Poliçe no">
                      <Link
                        className="customer-name"
                        to={`/policies/${encodeURIComponent(policy.id)}`}
                        state={{ policyList: listUrl, listPositionKey }}
                        data-list-return-target={policy.id}
                        onClick={rememberPosition}
                      >
                        {policy.policyNumber}
                      </Link>
                      {policy.labels?.plate && (
                        <span className="policy-list-secondary">{policy.labels.plate}</span>
                      )}
                    </td>
                    <td data-label="Ürün / Branş">
                      <span>{policy.labels?.productName ?? 'Ürün bilgisi kullanılamıyor'}</span>
                      {policy.labels?.branchName &&
                        policy.labels.branchName !== policy.labels.productName && (
                          <span className="policy-list-secondary">{policy.labels.branchName}</span>
                        )}
                    </td>
                    <td data-label="Sigorta şirketi">
                      {policy.labels?.insurerName ?? 'Şirket bilgisi kullanılamıyor'}
                    </td>
                    <td data-label="Poliçe dönemi">
                      <span className="policy-list-secondary">
                        Başlangıç {storedPolicyDate(policy.startDate)}
                      </span>
                      <span>Bitiş {storedPolicyDate(policy.endDate)}</span>
                    </td>
                    <td data-label="Prim" className="policy-list-premium">
                      {policyMoney(policy.grossPremiumMinor, policy.currency)}
                    </td>
                    <td data-label="Durum">
                      <PolicyPeriodBadge policy={policy} />
                      {(policy.status === 'ACTIVE' || policy.archivedAt) && (
                        <span className="policy-list-secondary">
                          Kayıt: <span>{policyStatusLabel[policy.status]}</span>
                        </span>
                      )}
                      {policy.archivedAt && (
                        <span className="policy-list-secondary">Arşivlenmiş</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="customer-pagination">
          <span>Her sayfada en fazla 20 kayıt · Arşiv durumu poliçe durumundan bağımsızdır.</span>
          <div>
            <Button
              variant="outline"
              disabled={state.loading || !cursor}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete('cursor');
                setParams(next);
              }}
            >
              İlk sayfa
            </Button>
            <Button
              variant="outline"
              disabled={state.loading || !state.data?.hasMore || !state.data.nextCursor}
              onClick={() => {
                if (state.data?.nextCursor) {
                  const next = new URLSearchParams(params);
                  next.set('cursor', state.data.nextCursor);
                  setParams(next);
                }
              }}
            >
              Sonraki sayfa
            </Button>
          </div>
        </div>
      </Card>
      <p className="policy-list-muted">
        Aktif kayıt, poliçenin bugün yürürlükte olduğu anlamına gelmez; dönem durumu ayrıca
        gösterilir.
      </p>
    </div>
  );
}

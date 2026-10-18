import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { PolicyListResponseData } from '../../../shared/types';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';
import { useCustomerResource } from '../customers/customer-resource';
import { policyDate, policyMoney, policyStatusLabel, PolicyReadNotice } from './policy-display';
const defaults = {
  search: '',
  searchMode: 'exact',
  status: '',
  endFrom: '',
  endTo: '',
  sort: 'end_date_asc',
};
function filters(params: URLSearchParams) {
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [key, params.get(key) ?? fallback]),
  ) as typeof defaults;
}
export default function PolicyListPage() {
  const [params, setParams] = useSearchParams();
  const signature = params.toString();
  const [draft, setDraft] = useState(() => filters(params));
  const [validation, setValidation] = useState('');
  useEffect(() => {
    setDraft(filters(new URLSearchParams(signature)));
    setValidation('');
  }, [signature]);
  const query = new URLSearchParams({ pageSize: '20' });
  for (const [key, value] of Object.entries(filters(params))) if (value) query.set(key, value);
  const cursor = params.get('cursor');
  if (cursor) query.set('cursor', cursor);
  const state = useCustomerResource<PolicyListResponseData>(`/api/policies?${query}`);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.endFrom && draft.endTo && draft.endFrom > draft.endTo) {
      setValidation('Bitiş başlangıcı, bitiş sonundan sonra olamaz.');
      return;
    }
    setValidation('');
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(draft)) if (value.trim()) next.set(key, value.trim());
    setParams(next);
    state.reload();
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
    <div className="customer-modern policy-modern">
      <PageHeader
        title="Poliçeler"
        description="Acente poliçelerini ve yetkili olduğunuz tarihsel kayıtları inceleyin."
        action={
          <Button asChild variant="outline">
            <Link to="/policies/legacy">Poliçe işlemleri (klasik)</Link>
          </Button>
        }
      />
      <Card className="customer-list-card">
        <form className="policy-filters customer-form-grid" onSubmit={submit}>
          {input('search', 'Poliçe numarası')}
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
              <option value="">Tüm durumlar</option>
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
          <div className="customer-form-actions">
            <Button type="submit">Filtrele</Button>
            <Button
              variant="ghost"
              onClick={() => {
                setParams({});
                setDraft(defaults);
                setValidation('');
                state.reload();
              }}
            >
              Temizle
            </Button>
          </div>
        </form>
        {validation && <p role="alert">{validation}</p>}
        <PolicyReadNotice {...state} />
        {state.data && !state.data.items.length && (
          <div className="customer-state">
            <h2>Poliçe bulunamadı</h2>
            <p>
              Filtreleri değiştirebilir veya klasik çalışma alanından yeni poliçe
              oluşturabilirsiniz.
            </p>
          </div>
        )}
        {state.data && !!state.data.items.length && (
          <table className="customer-table policy-table">
            <caption className="sr-only">Yetkili poliçe listesi</caption>
            <thead>
              <tr>
                <th>Poliçe numarası</th>
                <th>Teminat dönemi</th>
                <th>Bitiş tarihi</th>
                <th>Brüt prim / para birimi</th>
                <th>Poliçe durumu</th>
                <th>Kayıt durumu</th>
              </tr>
            </thead>
            <tbody>
              {state.data.items.map((policy) => (
                <tr key={policy.id}>
                  <td data-label="Poliçe numarası">
                    <Link
                      className="customer-name"
                      to={`/policies/${encodeURIComponent(policy.id)}`}
                    >
                      {policy.policyNumber}
                    </Link>
                  </td>
                  <td data-label="Teminat dönemi">
                    {policyDate(policy.startDate)} – {policyDate(policy.endDate)}
                  </td>
                  <td data-label="Bitiş tarihi">{policyDate(policy.endDate)}</td>
                  <td data-label="Brüt prim / para birimi">
                    {policyMoney(policy.grossPremiumMinor, policy.currency)}
                  </td>
                  <td data-label="Poliçe durumu">
                    <span className="customer-badge">{policyStatusLabel[policy.status]}</span>
                  </td>
                  <td data-label="Kayıt durumu">
                    <span className="customer-badge">
                      {policy.archivedAt ? 'Arşivlenmiş' : 'Arşivlenmemiş'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
      <p className="customer-legacy-hint">
        Liste yalnız sunucunun döndürdüğü poliçe alanlarını gösterir. Müşteri, sigortacı ve ürün
        bilgileri için poliçe detayını açın.
      </p>
    </div>
  );
}

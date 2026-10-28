import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { ArrowUpRight, MessageSquare, ShieldCheck } from 'lucide-react';
import type { CustomerDetailDto, PolicyListResponseData } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { RenewalInteractionsSection } from '../today-work/RenewalInteractionsSection';
import type { InteractionRisk } from '../today-work/interaction-model';
import { useCustomerResource } from './customer-resource';
const date = (s: string) =>
  new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'medium' }).format(
    new Date(s.length === 10 ? s + 'T12:00:00Z' : s),
  );
const renewalLabels: Record<string, string> = {
  CONTACT_PENDING: 'İletişim bekleniyor',
  CONTACTED: 'Görüşüldü',
  QUOTE_PREPARING: 'Teklif hazırlanıyor',
  QUOTE_SENT: 'Teklif gönderildi',
  AWAITING_RESPONSE: 'Yanıt bekleniyor',
  WON: 'Yenilendi',
  LOST: 'Yenilenmedi',
  VOIDED: 'Geçersiz',
};
export function CustomerPolicies({ customerId }: { customerId: string }) {
  const route = useLocation();
  const [params, setParams] = useSearchParams();
  const appliedSearch = params.get('policySearch')?.trim() ?? '';
  const [search, setSearch] = useState(appliedSearch);
  useEffect(() => setSearch(appliedSearch), [appliedSearch, customerId]);
  const cursor = params.get('after');
  const query = new URLSearchParams({ customerId, pageSize: '20', includeLabels: 'true' });
  if (cursor) query.set('cursor', cursor);
  if (appliedSearch) query.set('customerSearch', appliedSearch);
  const { data, error, loading, reload } = useCustomerResource<PolicyListResponseData>(
    `/api/policies?${query}`,
  );
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Istanbul' }).format(
    new Date(),
  );
  const items = data?.items;
  const policyState = { ...route.state, customerPolicyReturn: route.pathname + route.search };
  const applySearch = (term: string) => {
    const next = new URLSearchParams(params);
    next.set('section', 'policies');
    next.delete('after');
    if (term.trim()) next.set('policySearch', term.trim());
    else next.delete('policySearch');
    setParams(next, { state: route.state });
  };
  const page = (after?: string) => {
    const next = new URLSearchParams(params);
    next.set('section', 'policies');
    if (after) next.set('after', after);
    else next.delete('after');
    setParams(next, { state: route.state });
  };
  return (
    <section className="c360-panel" aria-label="Müşteri poliçeleri">
      <div className="c360-panel-heading">
        <div>
          <h2>Mevcut poliçeler</h2>
          <p>Yalnız bu müşterinin görüntülemeye yetkili olduğunuz kayıtları.</p>
        </div>
        <ShieldCheck size={20} aria-hidden="true" />
      </div>
      <form
        className="c360-policy-search"
        onSubmit={(e) => {
          e.preventDefault();
          applySearch(search);
        }}
      >
        <label className="c360-search">
          Bu müşterinin tüm poliçelerinde ara
          <Input
            type="search"
            placeholder="Poliçe, ürün veya sigorta şirketi"
            value={search}
            maxLength={100}
            aria-describedby="customer-policy-search-help"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <Button type="submit">Poliçelerde ara</Button>
        {(appliedSearch || search) && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSearch('');
              applySearch('');
            }}
          >
            Aramayı temizle
          </Button>
        )}
        <p id="customer-policy-search-help">
          Poliçe numarası, ürün veya sigorta şirketi adına göre yetkili olduğunuz tüm müşteri
          poliçeleri aranır. Sonuçlar 20’şer gösterilir.
        </p>
      </form>
      {loading && <p role="status">Poliçeler yükleniyor…</p>}
      {error && (
        <div role="alert">
          <p>{error.message}</p>
          {error.status >= 500 && (
            <Button variant="outline" onClick={reload}>
              Poliçeleri yeniden dene
            </Button>
          )}
        </div>
      )}
      {data && (
        <>
          <div className="c360-policy-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">Poliçe / teminat</th>
                  <th scope="col">Sözleşme dönemi</th>
                  <th scope="col">Durum</th>
                  <th scope="col">
                    <span className="sr-only">İşlem</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items?.map((p) => {
                  const status = p.archivedAt
                    ? 'Arşivlenmiş'
                    : p.status === 'CANCELLED'
                      ? 'İptal'
                      : p.status === 'VOIDED'
                        ? 'Geçersiz'
                        : p.startDate > p.endDate
                          ? 'Tarih kontrolü'
                          : p.endDate < today
                            ? 'Süresi dolmuş'
                            : p.startDate > today
                              ? 'Başlangıcı bekleniyor'
                              : 'Yürürlükte';
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link
                          className="c360-policy-number"
                          to={`/policies/${encodeURIComponent(p.id)}`}
                          state={policyState}
                        >
                          {p.policyNumber}
                        </Link>
                        <strong>{p.labels?.productName ?? 'Ürün bilgisi sağlanmadı'}</strong>
                        <small>
                          {p.labels
                            ? `${p.labels.insurerName} · ${p.labels.branchName}`
                            : 'Yetkili etiket bilgisi sağlanmadı'}
                        </small>
                      </td>
                      <td>
                        <span>{date(p.startDate)} –</span>
                        <strong>{date(p.endDate)}</strong>
                      </td>
                      <td>
                        <span
                          className={
                            'c360-status ' + (status === 'Yürürlükte' ? 'is-active' : 'is-muted')
                          }
                        >
                          {status}
                        </span>
                        <small>
                          Kayıt:{' '}
                          {p.status === 'ACTIVE'
                            ? 'Aktif'
                            : p.status === 'CANCELLED'
                              ? 'İptal'
                              : 'Geçersiz'}
                        </small>
                      </td>
                      <td>
                        <Link
                          to={`/policies/${encodeURIComponent(p.id)}`}
                          state={policyState}
                          aria-label={`${p.policyNumber} poliçesini aç`}
                          className="c360-row-action"
                        >
                          <ArrowUpRight size={18} aria-hidden="true" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!items?.length && (
            <div className="c360-empty">
              <ShieldCheck size={26} aria-hidden="true" />
              <h3>
                {appliedSearch
                  ? 'Bu müşteride aramayla eşleşen poliçe yok'
                  : 'Görüntülenebilir poliçe bulunamadı'}
              </h3>
              <p>
                {appliedSearch
                  ? 'Aramayı değiştirin veya temizleyin.'
                  : 'Yeni poliçe ekleyebilir veya erişim kapsamınızı kontrol edebilirsiniz.'}
              </p>
            </div>
          )}
        </>
      )}
      <div className="customer-pagination">
        <span>
          {appliedSearch
            ? `“${appliedSearch}” için müşteri poliçeleri`
            : 'Bu müşterinin poliçeleri'}{' '}
          · Sayfa başına 20 kayıt
        </span>
        <Button variant="outline" disabled={!cursor || loading} onClick={() => page()}>
          İlk sayfa
        </Button>
        <Button
          variant="outline"
          disabled={loading || !data?.hasMore || !data.nextCursor}
          onClick={() => data?.nextCursor && page(data.nextCursor)}
        >
          Sonraki poliçeler
        </Button>
      </div>
    </section>
  );
}
interface Renewal {
  id: string;
  policyId?: string;
  policyNumber: string;
  policyEndDate: string;
  state: string;
  version: number;
}
interface RenewalPage {
  items: Renewal[];
  nextCursor: string | null;
}
export function CustomerRenewals({
  customer,
  onRiskChange,
}: {
  customer: CustomerDetailDto;
  onRiskChange: (r: { dirty: boolean; unresolved: boolean }) => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Renewal | null>(null);
  const [risk, setRisk] = useState<InteractionRisk>('clean');
  const riskRef = useRef<InteractionRisk>('clean');
  const changed = useCallback(
    (next: InteractionRisk) => {
      riskRef.current = next;
      setRisk(next);
      onRiskChange({
        dirty: next === 'draft',
        unresolved: next === 'uncertain' || next === 'saved-unread',
      });
    },
    [onRiskChange],
  );
  const { data, error, loading, reload } = useCustomerResource<RenewalPage>(
    `/api/customers/${encodeURIComponent(customer.id)}/renewals?includePolicyId=true${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
  );
  const route = useLocation();
  const locked = risk !== 'clean';
  const select = (item: Renewal | null) => {
    if (riskRef.current !== 'clean') return;
    setSelected(item);
  };
  return (
    <section className="c360-panel c360-renewals" aria-label="Müşteri yenilemeleri">
      <div className="c360-panel-heading">
        <div>
          <h2>Yenilemeler ve görüşmeler</h2>
          <p>Görüşme geçmişi ve yeni kayıtlar seçtiğiniz poliçenin yenilemesine aittir.</p>
        </div>
        <MessageSquare size={20} aria-hidden="true" />
      </div>
      {loading && <p role="status">Yenilemeler yükleniyor…</p>}
      {error && (
        <div role="alert">
          <p>{error.message}</p>
          {error.status >= 500 && (
            <Button variant="outline" disabled={locked} onClick={reload}>
              Yenilemeleri yeniden dene
            </Button>
          )}
        </div>
      )}
      {data && !data.items.length && (
        <div className="c360-empty">
          <MessageSquare size={25} aria-hidden="true" />
          <h3>Görüntülenebilir yenileme bulunamadı.</h3>
          <p>Bu durum özel takiplerin veya görünmeyen poliçelerin olmadığı anlamına gelmez.</p>
        </div>
      )}
      {data && !!data.items.length && (
        <>
          <div className="c360-renewal-list">
            {data.items.map((item) => (
              <div
                className="c360-renewal-row"
                key={item.id}
                data-selected={selected?.id === item.id}
              >
                <div>
                  <strong>{item.policyNumber}</strong>
                  <small>Vade: {date(item.policyEndDate)}</small>
                </div>
                <span className="c360-status is-muted">
                  {renewalLabels[item.state] ?? 'Durum bilgisi sağlanmadı'}
                </span>
                <Button
                  variant={selected?.id === item.id ? 'default' : 'outline'}
                  size="sm"
                  disabled={locked && selected?.id !== item.id}
                  aria-pressed={selected?.id === item.id}
                  onClick={() => select(item)}
                  aria-label={`${item.policyNumber} yenilemesini seç`}
                >
                  {selected?.id === item.id ? 'Seçili' : 'İncele'}
                </Button>
              </div>
            ))}
          </div>
          <div className="customer-pagination">
            <Button
              variant="outline"
              disabled={!cursor || loading || locked}
              onClick={() => {
                select(null);
                setCursor(null);
              }}
            >
              İlk yenilemeler
            </Button>
            <Button
              variant="outline"
              disabled={!data.nextCursor || loading || locked}
              onClick={() => {
                select(null);
                setCursor(data.nextCursor);
              }}
            >
              Sonraki yenilemeler
            </Button>
          </div>
        </>
      )}
      {!selected && data && !!data.items.length && (
        <div className="c360-selection-prompt">
          <MessageSquare size={18} aria-hidden="true" />
          <p>Bir yenileme seçin. Hiçbir poliçe veya işlem hedefi otomatik seçilmez.</p>
        </div>
      )}
      {selected && (
        <section className="c360-selected-renewal" aria-label="Seçili yenileme">
          <div className="c360-panel-heading">
            <div>
              <span className="c360-eyebrow">SEÇİLİ YENİLEME</span>
              <h3>{selected.policyNumber}</h3>
              <p>
                {customer.displayName} · Vade: {date(selected.policyEndDate)}
              </p>
            </div>
            <Button variant="ghost" size="sm" disabled={locked} onClick={() => select(null)}>
              Seçimi kapat
            </Button>
          </div>
          {locked && (
            <p className="c360-draft-notice" role="status">
              Açık görüşmeyi kaydedin veya iptal edin; bu sırada başka yenilemeye geçilmez.
            </p>
          )}
          <RenewalInteractionsSection
            key={selected.id}
            renewalId={selected.id}
            onRiskChange={changed}
          />
          {selected.policyId && (
            <div className="c360-advanced-note">
              <span>Seçili poliçe ve yenileme bağlamında devam edin.</span>
              <Link
                to={`/policies/${encodeURIComponent(selected.policyId)}?${new URLSearchParams({ section: 'renewal', renewal: selected.id, ...(cursor ? { renewalAfter: cursor } : {}) })}`}
                state={route.state}
              >
                Teklif ve sonuç işlemlerini aç <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
            </div>
          )}
        </section>
      )}
    </section>
  );
}

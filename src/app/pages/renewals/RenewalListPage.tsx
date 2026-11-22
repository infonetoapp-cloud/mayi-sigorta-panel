import { Link, useSearchParams } from 'react-router';
import { useId, useRef, useState, type FormEvent } from 'react';
import { PageHeader } from '../../components/layout/PageContainer';
import { useListReturn } from '../../components/layout/use-list-return';
import { Button } from '../../components/ui/button';
import { useCustomerResource } from '../customers/customer-resource';
import { policyMoney, storedPolicyDate } from '../policies/policy-display';
import { renewalStateLabels } from '../../../shared/renewal-browsing';
import { renewalBrowsePageSchema } from './renewal-browse-schemas';
export default function RenewalListPage() {
  const [params, setParams] = useSearchParams();
  const dateErrorId = useId();
  const dateFields = useRef<HTMLDetailsElement>(null);
  const dateStart = useRef<HTMLInputElement>(null);
  const [invalidDraft, setInvalidDraft] = useState(false);
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const invalidUrlRange = !!from && !!to && from > to;
  const dateError = invalidDraft || invalidUrlRange;
  const query = new URLSearchParams(params);
  query.set('limit', '20');
  const { data, error, loading, reload } = useCustomerResource(
    invalidUrlRange ? null : '/api/renewals?' + query.toString(),
    renewalBrowsePageSchema,
  );
  const {
    page: pageRef,
    tableRegion,
    rememberPosition,
    listUrl,
    listPositionKey,
  } = useListReturn(!!data);
  const detailState = { renewalList: listUrl, listPositionKey };
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget),
      next = new URLSearchParams();
    for (const key of ['q', 'view', 'from', 'to']) {
      const value = String(fields.get(key) ?? '').trim();
      if (value) next.set(key, value);
    }
    const start = next.get('from');
    const end = next.get('to');
    if (start && end && start > end) {
      setInvalidDraft(true);
      if (dateFields.current) dateFields.current.open = true;
      dateStart.current?.focus();
      return;
    }
    setInvalidDraft(false);
    if (params.get('customerId')) next.set('customerId', params.get('customerId')!);
    setParams(next);
  }
  function page(cursor: string | null) {
    const next = new URLSearchParams(params);
    if (cursor) next.set('cursor', cursor);
    else next.delete('cursor');
    setParams(next);
  }
  return (
    <div className="customer-modern renewal-browsing" ref={pageRef}>
      <PageHeader
        title="Yenilemeler"
        description="Müşterilerinizin açık ve tamamlanmış yenilemelerini inceleyin."
      />
      <form
        className="renewal-filters"
        aria-label="Yenileme filtreleri"
        method="get"
        action="/renewals"
        onSubmit={filter}
        key={[params.get('view'), params.get('q'), params.get('from'), params.get('to')].join(':')}
      >
        <label>
          Müşteri veya poliçe no
          <input
            type="search"
            name="q"
            maxLength={80}
            defaultValue={params.get('q') ?? ''}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <label>
          Yenileme durumu
          <select name="view" defaultValue={params.get('view') ?? 'OPEN'}>
            <option value="OPEN">Açık yenilemeler</option>
            <option value="CLOSED">Tamamlanan yenilemeler</option>
            <option value="ALL">Tüm yenilemeler</option>
          </select>
        </label>
        <details className="renewal-date-filters" ref={dateFields} open={invalidUrlRange}>
          <summary>
            Tarih aralığı
            {(from || to) && (
              <small>
                {from ? storedPolicyDate(from) : 'Başlangıç açık'} –{' '}
                {to ? storedPolicyDate(to) : 'Bitiş açık'}
              </small>
            )}
          </summary>
          <div>
            <label>
              Poliçe bitişi — başlangıç
              <input
                ref={dateStart}
                type="date"
                name="from"
                defaultValue={from}
                aria-invalid={dateError || undefined}
                aria-describedby={dateError ? dateErrorId : undefined}
                onChange={() => setInvalidDraft(false)}
              />
            </label>
            <label>
              Poliçe bitişi — son
              <input
                type="date"
                name="to"
                defaultValue={to}
                aria-invalid={dateError || undefined}
                aria-describedby={dateError ? dateErrorId : undefined}
                onChange={() => setInvalidDraft(false)}
              />
            </label>
          </div>
        </details>
        <Button type="submit">Ara</Button>
        <Button
          variant="ghost"
          onClick={() => {
            setInvalidDraft(false);
            setParams({});
          }}
        >
          Filtreleri temizle
        </Button>
      </form>
      {dateError && (
        <p id={dateErrorId} role="alert">
          Başlangıç tarihi bitiş tarihinden sonra olamaz.
        </p>
      )}
      {loading && <p role="status">Yenilemeler yükleniyor…</p>}
      {error && (
        <div>
          <p role="alert">{error.message}</p>
          <div className="customer-pagination">
            {error.status >= 500 && (
              <Button variant="outline" onClick={reload}>
                Yenilemeleri yeniden yükle
              </Button>
            )}
            {params.has('cursor') && (error.status >= 500 || error.status === 400) && (
              <Button variant="outline" onClick={() => page(null)}>
                İlk sayfaya dön
              </Button>
            )}
          </div>
        </div>
      )}
      {data && (
        <>
          <p role="status">Bu sayfada {data.items.length} yenileme gösteriliyor.</p>
          <div
            className="renewal-table-wrapper"
            ref={tableRegion}
            role="region"
            aria-labelledby="renewal-list-caption"
            tabIndex={0}
          >
            <table className="renewal-table">
              <caption id="renewal-list-caption">Görüntüleyebildiğiniz yenilemeler</caption>
              <thead>
                <tr>
                  <th scope="col">Müşteri</th>
                  <th scope="col">Poliçe / Şirket</th>
                  <th scope="col">Branş</th>
                  <th scope="col">Bitiş tarihi</th>
                  <th scope="col">Önceki prim</th>
                  <th scope="col">Durum</th>
                  <th scope="col">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id}>
                    <th scope="row">
                      <Link
                        className="customer-name"
                        to={'/renewals/' + encodeURIComponent(item.id)}
                        state={detailState}
                        data-list-return-target={item.id + ':customer'}
                        onClick={rememberPosition}
                      >
                        {item.customer.displayName}
                      </Link>
                    </th>
                    <td data-label="Poliçe / Şirket">
                      {item.policy.number}
                      <small>{item.policy.insurerName}</small>
                    </td>
                    <td data-label="Branş">{item.policy.branchName}</td>
                    <td data-label="Bitiş tarihi">{storedPolicyDate(item.policy.endDate)}</td>
                    <td data-label="Önceki prim">
                      {policyMoney(item.policy.grossPremiumMinor, item.policy.currency)}
                    </td>
                    <td data-label="Durum">
                      {renewalStateLabels[item.state]}
                      {item.parentArchived && <small>Arşiv kaydı</small>}
                    </td>
                    <td data-label="İşlem">
                      <Button asChild variant="outline">
                        <Link
                          aria-label={item.customer.displayName + ' yenilemesini aç'}
                          to={'/renewals/' + encodeURIComponent(item.id)}
                          state={detailState}
                          data-list-return-target={item.id + ':detail'}
                          onClick={rememberPosition}
                        >
                          Detayı aç
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.items.length === 0 && <p>Seçtiğiniz filtrelere uygun yenileme bulunamadı.</p>}
          <div className="customer-pagination">
            <Button variant="outline" disabled={!params.has('cursor')} onClick={() => page(null)}>
              İlk sayfa
            </Button>
            <Button
              variant="outline"
              disabled={!data.nextCursor}
              onClick={() => page(data.nextCursor)}
            >
              Sonraki yenilemeler
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

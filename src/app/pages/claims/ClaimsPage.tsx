import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { PolicyDto, SelectableCatalogsDto } from '../../../shared/types';
import { claimStatuses, type ClaimDetail } from '../../../shared/claims';
import { Button } from '../../components/ui/button';
import { PageHeader } from '../../components/layout/PageContainer';
import { usePanelReturn } from '../../components/layout/use-panel-return';
import { useCustomerResource } from '../customers/customer-resource';
import { CustomerNumberGuard } from '../customers/CustomerNumberGuard';
import type { TaskOperationRisk } from '../today-work/TaskOperationsSection';
import { policyDate } from '../policies/policy-display';
import { ClaimEditor } from './ClaimEditor';
import { claimDetailFor, claimPageFor } from './claim-read-schemas';
import { policyDetailFor, policyListReadSchema } from '../policies/policy-read-schemas';
function canStartClaim(
  policy: Pick<PolicyDto, 'customerId' | 'archivedAt' | 'status'>,
  customerId: string,
) {
  return (
    !policy.archivedAt &&
    policy.status !== 'VOIDED' &&
    (!customerId || policy.customerId === customerId)
  );
}
function ClaimCreate({
  policyId,
  customerId,
  onRisk,
  onDone,
  onClose,
  onChoosePolicy,
}: {
  policyId: string;
  customerId: string;
  onRisk: (r: TaskOperationRisk) => void;
  onDone: (d: ClaimDetail) => void;
  onClose: () => void;
  onChoosePolicy: () => void;
}) {
  const [selected, setSelected] = useState(policyId),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    title = useRef<HTMLHeadingElement>(null);
  const choices = useCustomerResource(
    selected
      ? null
      : '/api/policies?' +
          new URLSearchParams({
            pageSize: '20',
            includeLabels: 'true',
            searchMode: 'prefix',
            ...(query ? { search: query } : {}),
            ...(customerId ? { customerId } : {}),
          }),
    policyListReadSchema,
  );
  const decoder = useMemo(() => policyDetailFor(selected), [selected]);
  const policy = useCustomerResource(
    selected ? '/api/policies/' + encodeURIComponent(selected) : null,
    decoder,
  );
  const candidate = policy.data;
  const customerMismatch = !!(customerId && candidate && candidate.customerId !== customerId);
  const eligible = !!candidate && canStartClaim(candidate, customerId);
  const selectionError =
    selected && !policy.loading && !eligible
      ? customerMismatch
        ? 'Bağlantıdaki poliçe seçili müşteriye ait değil.'
        : candidate
          ? 'Bu poliçeye yeni hasar dosyası açılamaz.'
          : (policy.error?.message ?? 'Poliçe kullanılamıyor veya bu kayda erişiminiz yok.')
      : '';
  const options = choices.data?.items.filter((item) => canStartClaim(item, customerId));
  useEffect(() => {
    title.current?.focus();
  }, [selected, selectionError]);
  return (
    <section className="finance-record">
      {!selected ? (
        <>
          <h2 ref={title} tabIndex={-1}>
            Hasar için poliçe seçin
          </h2>
          <search>
            <form
              className="claim-policy-search"
              aria-label="Hasar için poliçe ara"
              method="get"
              onSubmit={(e) => {
                e.preventDefault();
                const next = search.trim();
                if (next === query) choices.reload();
                else setQuery(next);
              }}
            >
              <label htmlFor="claim-policy-q">Poliçe numarası ile ara</label>
              <div>
                <input
                  id="claim-policy-q"
                  name="search"
                  value={search}
                  maxLength={80}
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Button type="submit">Ara</Button>
              </div>
            </form>
          </search>
          {choices.loading && <p role="status">Poliçeler yükleniyor…</p>}
          {choices.error && (
            <div>
              <p role="alert">{choices.error.message}</p>
              {choices.error.status >= 500 && (
                <Button onClick={choices.reload}>Poliçeleri yeniden yükle</Button>
              )}
            </div>
          )}
          <label htmlFor="claim-policy">Poliçe seçin</label>
          <select
            id="claim-policy"
            name="policyId"
            value=""
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Seçin</option>
            {options?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.policyNumber} · {p.labels?.insurerName ?? 'Poliçe'} ·{' '}
                {p.labels?.branchName ?? ''}
              </option>
            ))}
          </select>
          {options?.length === 0 && (
            <p role="status">Uygun poliçe bulunamadı. Başka bir poliçe numarasıyla arayın.</p>
          )}
          <p>
            İlk 20 kayıt gösterilir. Eski dönem poliçeleri de seçilebilir; hasar tarihi poliçe
            döneminde olmalıdır.
          </p>
          <Button variant="outline" onClick={onClose}>
            Vazgeç
          </Button>
        </>
      ) : selectionError ? (
        <div>
          <h2 ref={title} tabIndex={-1}>
            Poliçe seçimini kontrol edin
          </h2>
          <p role="alert" className="customer-error">
            {selectionError}
          </p>
          <div className="customer-form-actions">
            {policy.error && policy.error.status >= 500 && (
              <Button variant="outline" onClick={policy.reload}>
                Seçili poliçeyi yeniden yükle
              </Button>
            )}
            <Button
              type="button"
              onClick={() => {
                onChoosePolicy();
                setSelected('');
              }}
            >
              Poliçe seç
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (customerMismatch) onChoosePolicy();
                onClose();
              }}
            >
              Kapat
            </Button>
          </div>
        </div>
      ) : eligible ? (
        <ClaimEditor policy={candidate} onRisk={onRisk} onDone={onDone} onClose={onClose} />
      ) : (
        <p role="status">Poliçe kontrol ediliyor…</p>
      )}
    </section>
  );
}
function ClaimDetailPanel({
  id,
  customerId,
  policyId,
  onRisk,
  onClose,
  onChanged,
}: {
  id: string;
  customerId: string;
  policyId: string;
  onRisk: (r: TaskOperationRisk) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [before, setBefore] = useState<number | null>(null),
    [editing, setEditing] = useState(false),
    [message, setMessage] = useState(''),
    heading = useRef<HTMLHeadingElement>(null);
  const decoder = useMemo(
    () => claimDetailFor(id, { customerId, policyId }),
    [id, customerId, policyId],
  );
  const r = useCustomerResource(
      '/api/claims/' + encodeURIComponent(id) + (before ? '?before=' + before : ''),
      decoder,
    ),
    d = r.data;
  useEffect(() => {
    if (d?.claim.id) heading.current?.focus();
  }, [d?.claim.id]);
  function closeEditor() {
    setEditing(false);
    onRisk({ dirty: false, unresolved: false });
  }
  function end() {
    closeEditor();
    r.reload();
  }
  return (
    <section className="finance-record" aria-label="Hasar dosyası detayı">
      {r.loading && <p role="status">Hasar dosyası yükleniyor…</p>}
      {r.error && (
        <div>
          <p role="alert">{r.error.message}</p>
          <div className="customer-form-actions">
            {r.error.status >= 500 && (
              <Button onClick={r.reload}>Hasar dosyasını yeniden yükle</Button>
            )}
            {r.error.status === 400 && before && (
              <Button variant="outline" onClick={() => setBefore(null)}>
                Son kayıtlara dön
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              Kapat
            </Button>
          </div>
        </div>
      )}
      {d && (
        <>
          {message && (
            <p role="status" className="finance-notice">
              {message}
            </p>
          )}
          <div className="finance-record-title">
            <div>
              <h2 ref={heading} tabIndex={-1}>
                {d.claim.customerName}
              </h2>
              <Link to={'/policies/' + encodeURIComponent(d.claim.policyId)}>
                {d.claim.policyNumber}
              </Link>
            </div>
            <Button variant="outline" disabled={editing} onClick={onClose}>
              Detayı kapat
            </Button>
          </div>
          <dl className="claim-summary">
            <div>
              <dt>Dosya no</dt>
              <dd>{d.claim.fileNumber ?? 'Henüz verilmedi'}</dd>
            </div>
            <div>
              <dt>Hasar tarihi</dt>
              <dd>{policyDate(d.claim.lossDate)}</dd>
            </div>
            <div>
              <dt>Şirket / Branş</dt>
              <dd>
                {d.claim.insurerName} · {d.claim.branchName}
              </dd>
            </div>
            <div>
              <dt>Referans kişi</dt>
              <dd>{d.claim.referenceName ?? 'Belirtilmedi'}</dd>
            </div>
            <div>
              <dt>Eksper</dt>
              <dd>
                {d.claim.expertName ?? 'Belirtilmedi'}
                {d.claim.expertContact && <small>{d.claim.expertContact}</small>}
              </dd>
            </div>
            <div>
              <dt>Durum</dt>
              <dd>
                <span className="claim-status" data-status={d.claim.status}>
                  {claimStatuses[d.claim.status]}
                </span>
              </dd>
            </div>
          </dl>
          {d.claim.note && (
            <p className="claim-last-note">
              <strong>Son durum notu</strong>
              <br />
              {d.claim.note}
            </p>
          )}
          {!editing && d.canManage && (
            <Button onClick={() => setEditing(true)}>Durumu / bilgileri güncelle</Button>
          )}
          {d.claim.parentArchived && (
            <p>Arşivlenmiş müşteri veya poliçenin geçmişi görüntüleniyor.</p>
          )}
          {editing && (
            <ClaimEditor
              detail={d}
              onRisk={onRisk}
              onClose={end}
              onDone={() => {
                setMessage('Güncelleme kaydedildi ve geçmiş kontrol edildi.');
                setBefore(null);
                closeEditor();
                if (!before) r.reload();
                onChanged();
              }}
            />
          )}
          <h3>İşlem ve not geçmişi</h3>
          <ol className="finance-history claim-history">
            {d.history.map((h) => (
              <li key={h.version}>
                <div>
                  <strong>{claimStatuses[h.fields.status]}</strong>
                  <small>
                    {new Intl.DateTimeFormat('tr-TR', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: 'Europe/Istanbul',
                    }).format(new Date(h.createdAt))}
                  </small>
                  <p>{h.fields.note ?? 'Hasar dosyası oluşturuldu.'}</p>
                  <small>
                    Hasar: {policyDate(h.fields.lossDate)} · Dosya:{' '}
                    {h.fields.fileNumber ?? 'Henüz verilmedi'} · Eksper:{' '}
                    {h.fields.expertName ?? 'Belirtilmedi'} {h.fields.expertContact ?? ''}
                  </small>
                </div>
              </li>
            ))}
          </ol>
          <div className="customer-form-actions">
            {before && (
              <Button variant="outline" disabled={editing} onClick={() => setBefore(null)}>
                Son kayıtlar
              </Button>
            )}
            {d.nextHistoryVersion && (
              <Button
                variant="outline"
                disabled={editing}
                onClick={() => setBefore(d.nextHistoryVersion)}
              >
                Önceki kayıtlar
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
export default function ClaimsPage() {
  const [params, setParams] = useSearchParams(),
    [q, setQ] = useState(params.get('q') ?? ''),
    [status, setStatus] = useState(params.get('status') ?? 'ALL'),
    [from, setFrom] = useState(params.get('from') ?? ''),
    [to, setTo] = useState(params.get('to') ?? ''),
    [branch, setBranch] = useState(params.get('branchId') ?? ''),
    [creating, setCreating] = useState(false),
    [risk, setRisk] = useState<TaskOperationRisk>({ dirty: false, unresolved: false }),
    [message, setMessage] = useState(''),
    [filterError, setFilterError] = useState('');
  const onRisk = useCallback(
      (r: TaskOperationRisk) =>
        setRisk((p) => (p.dirty === r.dirty && p.unresolved === r.unresolved ? p : r)),
      [],
    ),
    locked = risk.dirty || risk.unresolved,
    query = new URLSearchParams(params);
  query.delete('file');
  const customerId = params.get('customerId') ?? '';
  const policyId = params.get('policyId') ?? '';
  const decoder = useMemo(() => claimPageFor({ customerId, policyId }), [customerId, policyId]);
  const url = '/api/claims?' + query;
  const list = useCustomerResource(url, decoder),
    catalogs = useCustomerResource<SelectableCatalogsDto>(
      list.data ? '/api/catalogs/selectable' : null,
    ),
    selected = params.get('file');
  const panel = usePanelReturn(creating ? 'new' : selected, url, !!list.data);
  const qParam = params.get('q') ?? '',
    statusParam = params.get('status') ?? 'ALL',
    fromParam = params.get('from') ?? '',
    toParam = params.get('to') ?? '',
    branchParam = params.get('branchId') ?? '';
  useEffect(() => {
    setQ(qParam);
    setStatus(statusParam);
    setFrom(fromParam);
    setTo(toParam);
    setBranch(branchParam);
    setFilterError('');
  }, [qParam, statusParam, fromParam, toParam, branchParam]);
  function open(id: string | null) {
    const next = new URLSearchParams(params);
    if (id) next.set('file', id);
    else next.delete('file');
    setParams(next, { replace: id === null });
    setCreating(false);
    onRisk({ dirty: false, unresolved: false });
  }
  function clearPolicyFilter() {
    if (!params.has('policyId')) return;
    const next = new URLSearchParams(params);
    next.delete('policyId');
    next.delete('cursor');
    setParams(next, { replace: true });
  }
  function filters(e: FormEvent) {
    e.preventDefault();
    if (locked) return;
    if (from && to && from > to) {
      setFilterError('Başlangıç tarihi bitişten sonra olamaz.');
      return;
    }
    setFilterError('');
    const next = new URLSearchParams(query);
    next.delete('cursor');
    for (const [key, value] of Object.entries({
      q: q.trim(),
      status,
      from,
      to,
      branchId: branch,
    })) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next);
  }
  return (
    <div className="customer-modern finance-page claims-page" ref={panel.page}>
      <CustomerNumberGuard
        label="Hasar kaydı"
        dirty={risk.dirty}
        unresolved={risk.unresolved}
        protectSearch
      />
      <PageHeader
        title="Hasar Dosyaları"
        description="Dosyanın son durumunu ve görüşme notlarını tek yerde takip edin."
        action={
          list.data?.canManage ? (
            <Button
              disabled={locked}
              onClick={() => {
                open(null);
                setCreating(true);
                setMessage('');
              }}
            >
              Yeni hasar kaydı
            </Button>
          ) : undefined
        }
      />
      {message && (
        <p role="status" className="finance-notice">
          {message}
        </p>
      )}
      <search>
        <form aria-label="Hasar filtreleri" className="finance-filters" onSubmit={filters}>
          <fieldset disabled={locked}>
            <legend className="sr-only">Dosya arama ve filtreler</legend>
            <label>
              Müşteri, dosya veya poliçe no ara
              <input
                name="q"
                value={q}
                maxLength={80}
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <label>
              Branş
              <select name="branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
                <option value="">Tümü</option>
                {catalogs.data?.branches?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Durum
              <select name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="ALL">Tümü</option>
                {Object.entries(claimStatuses).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <details className="claim-date-filter">
              <summary>Hasar tarihi aralığı</summary>
              <label>
                Başlangıç
                <input
                  name="from"
                  type="date"
                  value={from}
                  onInput={(e) => setFrom(e.currentTarget.value)}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                Bitiş
                <input
                  name="to"
                  type="date"
                  value={to}
                  onInput={(e) => setTo(e.currentTarget.value)}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </details>
            <Button type="submit">Ara</Button>
            <Button
              variant="outline"
              onClick={() => {
                setQ('');
                setStatus('ALL');
                setFrom('');
                setTo('');
                setBranch('');
                setFilterError('');
                setCreating(false);
                setParams({});
              }}
            >
              Temizle
            </Button>
          </fieldset>
        </form>
      </search>
      {filterError && <p role="alert">{filterError}</p>}
      {(params.has('customerId') || params.has('policyId')) && (
        <p className="claim-scope">
          Seçtiğiniz müşteri veya poliçeye bağlı dosyalar gösteriliyor. Tümü için filtreleri
          temizleyin.
        </p>
      )}
      {creating && (
        <ClaimCreate
          key={customerId}
          policyId={policyId}
          customerId={customerId}
          onChoosePolicy={clearPolicyFilter}
          onRisk={onRisk}
          onClose={() => {
            setCreating(false);
            onRisk({ dirty: false, unresolved: false });
          }}
          onDone={(d) => {
            setMessage('Hasar kaydı oluşturuldu ve geçmiş kontrol edildi.');
            open(d.claim.id);
            list.reload();
          }}
        />
      )}
      {selected && !creating && (
        <ClaimDetailPanel
          key={JSON.stringify([selected, customerId, policyId])}
          id={selected}
          customerId={customerId}
          policyId={policyId}
          onRisk={onRisk}
          onClose={() => open(null)}
          onChanged={list.reload}
        />
      )}
      {list.loading && <p role="status">Hasar dosyaları yükleniyor…</p>}
      {list.error && (
        <div>
          <p role="alert">{list.error.message}</p>
          <div className="customer-form-actions">
            {list.error.status >= 500 && (
              <Button disabled={locked} onClick={list.reload}>
                Listeyi yeniden yükle
              </Button>
            )}
            {params.has('cursor') && (list.error.status >= 500 || list.error.status === 400) && (
              <Button
                variant="outline"
                disabled={locked}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete('cursor');
                  setParams(next);
                }}
              >
                İlk sayfaya dön
              </Button>
            )}
          </div>
        </div>
      )}
      {list.data && (
        <>
          <div
            className="finance-table-wrap"
            ref={panel.table}
            tabIndex={0}
            role="region"
            aria-label="Hasar dosyaları"
          >
            <table className="finance-table claim-table">
              <caption>Bu sayfada {list.data.items.length} dosya</caption>
              <thead>
                <tr>
                  {[
                    'Hasar tarihi',
                    'Müşteri / Poliçe',
                    'Şirket / Branş',
                    'Dosya no',
                    'Eksper',
                    'Durum / Son not',
                    'İşlem',
                  ].map((h) => (
                    <th key={h} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((c) => (
                  <tr key={c.id}>
                    <td data-label="Hasar tarihi">{policyDate(c.lossDate)}</td>
                    <th scope="row">
                      <button
                        type="button"
                        className="finance-customer"
                        disabled={locked || creating}
                        data-panel-trigger={c.id + ':customer'}
                        onClick={(event) => {
                          panel.remember(event);
                          setMessage('');
                          open(c.id);
                        }}
                      >
                        {c.customerName}
                      </button>
                      <small>{c.policyNumber}</small>
                    </th>
                    <td data-label="Şirket / Branş">
                      {c.insurerName}
                      <small>{c.branchName}</small>
                    </td>
                    <td data-label="Dosya no">{c.fileNumber ?? 'Henüz verilmedi'}</td>
                    <td data-label="Eksper">{c.expertName ?? 'Belirtilmedi'}</td>
                    <td data-label="Durum / Son not">
                      <div>
                        <span className="claim-status" data-status={c.status}>
                          {claimStatuses[c.status]}
                        </span>
                        <small className="claim-row-note">{c.note ?? 'Not eklenmemiş'}</small>
                      </div>
                    </td>
                    <td data-label="İşlem">
                      <Button
                        disabled={locked || creating}
                        variant="outline"
                        data-panel-trigger={c.id + ':detail'}
                        onClick={(event) => {
                          panel.remember(event);
                          setMessage('');
                          open(c.id);
                        }}
                      >
                        Detay
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!list.data.items.length && (
              <p className="finance-empty">Bu filtrelerde hasar dosyası yok.</p>
            )}
          </div>
          <div className="customer-form-actions">
            {params.has('cursor') && (
              <Button
                disabled={locked}
                variant="outline"
                onClick={() => {
                  const n = new URLSearchParams(params);
                  n.delete('cursor');
                  setParams(n);
                }}
              >
                İlk sayfa
              </Button>
            )}
            {list.data.nextCursor && (
              <Button
                disabled={locked}
                variant="outline"
                onClick={() => {
                  const n = new URLSearchParams(params);
                  n.set('cursor', list.data!.nextCursor!);
                  setParams(n);
                }}
              >
                Sonraki dosyalar
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

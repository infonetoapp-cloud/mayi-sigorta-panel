import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react';
import { Link, useSearchParams } from 'react-router';
import type { SelectableCatalogsDto } from '../../../shared/types';
import {
  financeMethodLabels,
  financeReasons,
  type FinanceDetail,
  type FinanceEntry,
  type FinanceReceivable,
} from '../../../shared/finance';
import { Button } from '../../components/ui/button';
import { PageHeader } from '../../components/layout/PageContainer';
import { usePanelReturn } from '../../components/layout/use-panel-return';
import { useCustomerResource } from '../customers/customer-resource';
import { CustomerNumberGuard } from '../customers/CustomerNumberGuard';
import type { TaskOperationRisk } from '../today-work/TaskOperationsSection';
import { policyDate, policyMoney } from '../policies/policy-display';
import { FinanceEditor } from './FinanceEditor';
import { financeDetailFor, financePageSchema } from './finance-read-schemas';
import { policyDetailFor, policyListReadSchema } from '../policies/policy-read-schemas';
const stateLabels = {
  OPEN: 'Açık',
  PARTIAL: 'Kısmi tahsilat',
  COLLECTED: 'Tahsil edildi',
  OVERDUE: 'Gecikmiş',
  VOIDED: 'İptal edilmiş kayıt',
};
function CreateReceivable({
  initialPolicy,
  onRisk,
  onDone,
  onClose,
}: {
  initialPolicy: string;
  onRisk: (r: TaskOperationRisk) => void;
  onDone: (d: FinanceDetail) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [selected, setSelected] = useState(initialPolicy),
    title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  const choices = useCustomerResource(
    selected
      ? null
      : '/api/policies?' +
          new URLSearchParams({
            pageSize: '20',
            status: 'ACTIVE',
            includeLabels: 'true',
            searchMode: 'prefix',
            ...(query ? { search: query } : {}),
          }),
    policyListReadSchema,
  );
  return (
    <section className="finance-record">
      {!selected ? (
        <>
          <h2 ref={title} tabIndex={-1}>
            Alacak için poliçe seçin
          </h2>
          <form
            aria-label="Alacak için poliçe ara"
            className="finance-filters"
            onSubmit={(e) => {
              e.preventDefault();
              const next = search.trim();
              if (next === query) choices.reload();
              else setQuery(next);
            }}
          >
            <label>
              Poliçe numarası ile ara
              <input value={search} maxLength={80} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <Button type="submit">Ara</Button>
          </form>
          {choices.loading && <p role="status">Poliçeler yükleniyor…</p>}
          {choices.error && (
            <div>
              <p role="alert">{choices.error.message}</p>
              {choices.error.status >= 500 && (
                <Button variant="outline" onClick={choices.reload}>
                  Poliçe listesini yeniden yükle
                </Button>
              )}
            </div>
          )}
          <label>
            Poliçe seçin
            <select value="" onChange={(e) => setSelected(e.target.value)}>
              <option value="">Seçin</option>
              {choices.data?.items
                .filter((p) => !p.archivedAt)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.policyNumber} · {p.labels?.branchName ?? 'Poliçe'}
                  </option>
                ))}
            </select>
          </label>
          <p>
            Aramada ilk 20 uygun poliçe gösterilir. Poliçe numarasıyla aramayı daraltabilirsiniz.
          </p>
          <Button variant="outline" onClick={onClose}>
            Vazgeç
          </Button>
        </>
      ) : (
        <PolicyReady id={selected} onRisk={onRisk} onDone={onDone} onClose={onClose} />
      )}
    </section>
  );
}
function PolicyReady({
  id,
  onRisk,
  onDone,
  onClose,
}: {
  id: string;
  onRisk: (r: TaskOperationRisk) => void;
  onDone: (d: FinanceDetail) => void;
  onClose: () => void;
}) {
  const decoder = useMemo(() => policyDetailFor(id), [id]);
  const r = useCustomerResource('/api/policies/' + encodeURIComponent(id), decoder);
  const policy = r.data;
  if (r.loading) return <p role="status">Poliçe kontrol ediliyor…</p>;
  if (!policy || policy.archivedAt || policy.status !== 'ACTIVE') {
    return (
      <>
        <p role="alert">
          {policy
            ? 'Bu poliçeye yeni alacak kaydı açılamaz.'
            : (r.error?.message ?? 'Poliçe kullanılamıyor veya erişim yetkiniz yok.')}
        </p>
        {r.error && r.error.status >= 500 && (
          <Button variant="outline" onClick={r.reload}>
            Poliçeyi yeniden yükle
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>
          Kapat
        </Button>
      </>
    );
  }
  return (
    <FinanceEditor
      kind="CREATE"
      policy={policy}
      onRisk={onRisk}
      onDone={onDone}
      onClose={onClose}
    />
  );
}
function Detail({
  id,
  onRisk,
  onClose,
  onChanged,
}: {
  id: string;
  onRisk: (r: TaskOperationRisk) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [before, setBefore] = useState(''),
    [revisionBefore, setRevisionBefore] = useState<number | null>(null),
    [operation, setOperation] = useState<'COLLECT' | 'REVERSE' | 'ADJUST' | 'VOID' | null>(null),
    [entry, setEntry] = useState<FinanceEntry | undefined>(),
    [message, setMessage] = useState('');
  const decoder = useMemo(() => financeDetailFor(id), [id]);
  const r = useCustomerResource(
      '/api/finance/receivables/' +
        encodeURIComponent(id) +
        '?' +
        new URLSearchParams({
          ...(before ? { entriesBefore: before } : {}),
          ...(revisionBefore ? { revisionsBefore: String(revisionBefore) } : {}),
        }),
      decoder,
    ),
    d = r.data;
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (d?.receivable.id) titleRef.current?.focus();
  }, [d?.receivable.id]);
  const closeEditor = () => {
    setOperation(null);
    onRisk({ dirty: false, unresolved: false });
  };
  const end = () => {
    closeEditor();
    r.reload();
  };
  return (
    <section className="finance-record" aria-label="Alacak ve tahsilat detayı">
      {message && <p role="status">{message}</p>}
      {r.loading && <p role="status">Alacak ve geçmişi yükleniyor…</p>}
      {r.error && (
        <div>
          <p role="alert">{r.error.message}</p>
          <div className="customer-form-actions">
            {r.error.status >= 500 && <Button onClick={r.reload}>Alacağı yeniden yükle</Button>}
            {r.error.status === 400 && (before || revisionBefore) && (
              <Button
                variant="outline"
                onClick={() => {
                  setBefore('');
                  setRevisionBefore(null);
                }}
              >
                Son işlemlere dön
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              Detayı kapat
            </Button>
          </div>
        </div>
      )}
      {d && (
        <>
          <div className="finance-record-title">
            <div>
              <h2 ref={titleRef} tabIndex={-1}>
                {d.receivable.customerName}
              </h2>
              <Link to={'/policies/' + encodeURIComponent(d.receivable.policyId)}>
                {d.receivable.policyNumber}
              </Link>
            </div>
            <Button variant="outline" disabled={!!operation} onClick={onClose}>
              Detayı kapat
            </Button>
          </div>
          <dl className="finance-balance">
            <div>
              <dt>Acente alacağı</dt>
              <dd>{policyMoney(d.receivable.amountMinor, d.receivable.currency)}</dd>
            </div>
            <div>
              <dt>Tahsil edilen</dt>
              <dd>{policyMoney(d.receivable.collectedMinor, d.receivable.currency)}</dd>
            </div>
            <div>
              <dt>Kalan</dt>
              <dd>{policyMoney(d.receivable.remainingMinor, d.receivable.currency)}</dd>
            </div>
          </dl>
          <p>
            Ödeme vadesi: {policyDate(d.receivable.dueDate)} · {stateLabels[d.receivable.state]}
          </p>
          {!operation && d.canManage && d.receivable.status === 'ACTIVE' && (
            <div className="customer-form-actions" role="group" aria-label="Alacak işlemleri">
              {d.receivable.remainingMinor > 0 && (
                <Button onClick={() => setOperation('COLLECT')}>Tahsilat kaydet</Button>
              )}
              <Button variant="outline" onClick={() => setOperation('ADJUST')}>
                Alacağı veya vadeyi düzelt
              </Button>
              {d.receivable.collectedMinor === 0 && (
                <Button variant="danger" onClick={() => setOperation('VOID')}>
                  Alacağı iptal et
                </Button>
              )}
            </div>
          )}
          {operation && (
            <FinanceEditor
              kind={operation}
              detail={d}
              entry={entry}
              onRisk={onRisk}
              onClose={end}
              onDone={() => {
                setMessage('İşlem kaydedildi ve güncel bakiye kontrol edildi.');
                setBefore('');
                setRevisionBefore(null);
                closeEditor();
                if (!before && !revisionBefore) r.reload();
                onChanged();
              }}
            />
          )}
          <h3>Tahsilat geçmişi</h3>
          {!d.entries.length && <p>Tahsilat kaydı yok.</p>}
          <ul className="finance-history">
            {d.entries.map((e) => (
              <li key={e.id}>
                <div>
                  <strong>
                    {e.kind === 'REVERSAL' ? 'Ters kayıt' : 'Tahsilat'} ·{' '}
                    {policyMoney(e.amountMinor, d.receivable.currency)}
                  </strong>
                  <p>
                    {policyDate(e.receivedDate)} · {financeMethodLabels[e.method]}
                    {e.reasonCode ? ' · ' + financeReasons[e.reasonCode] : ''}
                    {e.reversed ? ' · Ters kaydı var' : ''}
                  </p>
                </div>
                {e.kind === 'PAYMENT' &&
                  !e.reversed &&
                  !operation &&
                  d.canManage &&
                  d.receivable.status === 'ACTIVE' && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setEntry(e);
                        setOperation('REVERSE');
                      }}
                    >
                      Hatalı kaydı düzelt
                    </Button>
                  )}
              </li>
            ))}
          </ul>
          <div className="customer-form-actions">
            {before && (
              <Button disabled={!!operation} variant="outline" onClick={() => setBefore('')}>
                Son tahsilatlar
              </Button>
            )}
            {d.entriesNextCursor && (
              <Button
                disabled={!!operation}
                variant="outline"
                onClick={() => setBefore(d.entriesNextCursor!)}
              >
                Önceki tahsilatlar
              </Button>
            )}
          </div>
          <details className="finance-revisions">
            <summary>Alacak ve vade değişiklikleri</summary>
            <ul>
              {d.revisions.map((v) => (
                <li key={v.version}>
                  {policyDate(v.createdAt)} · {policyMoney(v.amountMinor, d.receivable.currency)} ·
                  Vade {policyDate(v.dueDate)} ·{' '}
                  {v.status === 'VOIDED'
                    ? 'İptal'
                    : v.reasonCode
                      ? financeReasons[v.reasonCode]
                      : 'İlk kayıt'}
                </li>
              ))}
            </ul>
            <div className="customer-form-actions">
              {revisionBefore && (
                <Button disabled={!!operation} onClick={() => setRevisionBefore(null)}>
                  Son düzeltmeler
                </Button>
              )}
              {d.revisionsNextCursor && (
                <Button
                  disabled={!!operation}
                  onClick={() => setRevisionBefore(d.revisionsNextCursor!)}
                >
                  Önceki düzeltmeler
                </Button>
              )}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
export default function FinancePage() {
  const [params, setParams] = useSearchParams(),
    [search, setSearch] = useState(params.get('q') ?? ''),
    [due, setDue] = useState(params.get('due') ?? 'ALL'),
    [branch, setBranch] = useState(params.get('branchId') ?? ''),
    [creating, setCreating] = useState(false),
    [message, setMessage] = useState(''),
    [risk, setRisk] = useState<TaskOperationRisk>({ dirty: false, unresolved: false });
  const onRisk = useCallback(
      (r: TaskOperationRisk) =>
        setRisk((p) => (p.dirty === r.dirty && p.unresolved === r.unresolved ? p : r)),
      [],
    ),
    locked = risk.dirty || risk.unresolved;
  const view = params.get('view') ?? 'OPEN',
    dueParam = view === 'COLLECTED' ? 'ALL' : (params.get('due') ?? 'ALL'),
    query = new URLSearchParams({
      view,
      due: dueParam,
      ...(params.get('q') ? { q: params.get('q')! } : {}),
      ...(params.get('cursor') ? { cursor: params.get('cursor')! } : {}),
      ...(params.get('policyId') ? { policyId: params.get('policyId')! } : {}),
      ...(params.get('branchId') ? { branchId: params.get('branchId')! } : {}),
    });
  const url = '/api/finance/receivables?' + query;
  const selected = params.get('receivable');
  const list = useCustomerResource(url, financePageSchema);
  const panel = usePanelReturn(creating ? 'new' : selected, url, !!list.data);
  const searchParam = params.get('q') ?? '',
    branchParam = params.get('branchId') ?? '';
  useEffect(() => {
    setSearch(searchParam);
    setDue(dueParam);
    setBranch(branchParam);
  }, [searchParam, dueParam, branchParam]);
  function select(id: string | null) {
    if (id === selected) return;
    const next = new URLSearchParams(params);
    if (id) next.set('receivable', id);
    else next.delete('receivable');
    setParams(next, { replace: !id });
  }
  const catalogs = useCustomerResource<SelectableCatalogsDto>(
    list.data ? '/api/catalogs/selectable' : null,
  );
  const messageRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) messageRef.current?.focus();
  }, [message]);
  function filters(e: FormEvent) {
    e.preventDefault();
    if (locked) return;
    const next = new URLSearchParams(query);
    next.delete('cursor');
    next.set('q', search.trim());
    next.set('due', view === 'COLLECTED' ? 'ALL' : due);
    if (branch) next.set('branchId', branch);
    else next.delete('branchId');
    setParams(next);
  }
  const done = (d: FinanceDetail) => {
    setCreating(false);
    select(d.receivable.id);
    onRisk({ dirty: false, unresolved: false });
    setMessage('Acente alacağı kaydedildi ve kontrol edildi. Tahsilat ayrıca eklenir.');
    list.reload();
  };
  return (
    <div className="customer-modern finance-page" ref={panel.page}>
      <CustomerNumberGuard
        label="Muhasebe kaydı"
        dirty={risk.dirty}
        unresolved={risk.unresolved}
        protectSearch
      />
      <PageHeader
        title="Muhasebe"
        description="Yalnız acentenizin alacak ve aldığı ödemeleri takip edin."
        action={
          list.data?.canManage ? (
            <Button
              disabled={locked}
              onClick={() => {
                setCreating(true);
                select(null);
                setMessage('');
              }}
            >
              Yeni acente alacağı
            </Button>
          ) : undefined
        }
      />
      {message && (
        <p ref={messageRef} tabIndex={-1} role="status" className="finance-notice">
          {message}
        </p>
      )}
      <div role="group" aria-label="Muhasebe görünümü" className="finance-tabs">
        {Object.entries({
          OPEN: 'Açık Vadeler',
          COLLECTED: 'Tahsil Edilenler',
          ALL: 'Tüm İşlemler',
        }).map(([code, title]) => (
          <Button
            key={code}
            disabled={locked}
            variant="outline"
            aria-pressed={view === code}
            onClick={() => {
              const next = new URLSearchParams(query);
              next.delete('cursor');
              next.set('view', code);
              if (code === 'COLLECTED') next.set('due', 'ALL');
              setParams(next);
            }}
          >
            {title}
          </Button>
        ))}
      </div>
      <form className="finance-filters" aria-label="Muhasebe filtreleri" onSubmit={filters}>
        <fieldset disabled={locked}>
          <legend className="sr-only">Arama ve vade</legend>
          <label>
            Müşteri, poliçe veya plaka ara
            <input
              name="q"
              value={search}
              maxLength={80}
              onChange={(e) => setSearch(e.target.value)}
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
          {view !== 'COLLECTED' && (
            <label>
              Vade durumu
              <select name="due" value={due} onChange={(e) => setDue(e.target.value)}>
                <option value="ALL">Tümü</option>
                <option value="OVERDUE">Geciken</option>
                <option value="TODAY">Bugün</option>
              </select>
            </label>
          )}
          <Button type="submit">Ara</Button>
          <Button
            variant="outline"
            onClick={() => {
              setSearch('');
              setDue('ALL');
              setBranch('');
              const next = new URLSearchParams(query);
              next.delete('cursor');
              next.delete('q');
              next.delete('branchId');
              next.delete('policyId');
              next.set('due', 'ALL');
              setParams(next);
            }}
          >
            Temizle
          </Button>
        </fieldset>
      </form>
      {params.get('policyId') && (
        <p className="finance-notice">
          Bu poliçenin alacakları gösteriliyor. Diğer poliçeler için filtreleri temizleyin.
        </p>
      )}
      {creating && (
        <CreateReceivable
          initialPolicy={params.get('policyId') ?? ''}
          onRisk={onRisk}
          onDone={done}
          onClose={() => {
            setCreating(false);
            onRisk({ dirty: false, unresolved: false });
          }}
        />
      )}
      {selected && (
        <Detail
          key={selected}
          id={selected}
          onRisk={onRisk}
          onClose={() => {
            select(null);
            onRisk({ dirty: false, unresolved: false });
          }}
          onChanged={list.reload}
        />
      )}
      {list.loading && <p role="status">Muhasebe kayıtları yükleniyor…</p>}
      {list.error && (
        <div>
          <p role="alert">{list.error.message}</p>
          <div className="customer-form-actions">
            {list.error.status >= 500 && (
              <Button disabled={locked} onClick={list.reload}>
                Listeyi yeniden yükle
              </Button>
            )}
            {params.has('cursor') && (list.error.status === 400 || list.error.status >= 500) && (
              <Button
                disabled={locked}
                variant="outline"
                onClick={() => {
                  const next = new URLSearchParams(query);
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
            aria-label="Acente alacakları"
          >
            <table className="finance-table">
              <caption>Acente alacakları · Bu sayfada {list.data.items.length} kayıt</caption>
              <thead>
                <tr>
                  <th scope="col">Müşteri / Poliçe</th>
                  <th scope="col">Branş</th>
                  <th scope="col">Alacak</th>
                  <th scope="col">Tahsilat</th>
                  <th scope="col">Kalan</th>
                  <th scope="col">Ödeme / Vade</th>
                  <th scope="col">Durum</th>
                  <th scope="col">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((r) => (
                  <FinanceRow
                    key={r.id}
                    row={r}
                    disabled={locked || creating}
                    onOpen={(event) => {
                      panel.remember(event);
                      select(r.id);
                      setCreating(false);
                      setMessage('');
                    }}
                  />
                ))}
              </tbody>
            </table>
            {!list.data.items.length && (
              <p className="finance-empty">Bu filtrelerde alacak kaydı yok.</p>
            )}
          </div>
          <div className="finance-totals" aria-label="Filtrelenmiş kayıtların toplamı">
            {list.data.totals.map((t) => (
              <p key={t.currency}>
                <strong>{t.currency}</strong> · Alacak {policyMoney(t.amountMinor, t.currency)} ·
                Tahsil edilen {policyMoney(t.collectedMinor, t.currency)} · Kalan{' '}
                <strong>{policyMoney(t.remainingMinor, t.currency)}</strong>
              </p>
            ))}
            <small>
              Toplamlar erişiminiz olan filtreli kayıtların tamamıdır; farklı para birimleri
              birleştirilmez. İptal edilmiş alacaklar toplama katılmaz.
            </small>
          </div>
          <div className="customer-form-actions">
            {params.get('cursor') && (
              <Button
                disabled={locked}
                variant="outline"
                onClick={() => {
                  const next = new URLSearchParams(query);
                  next.delete('cursor');
                  setParams(next);
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
                  const next = new URLSearchParams(query);
                  next.set('cursor', list.data!.nextCursor!);
                  setParams(next);
                }}
              >
                Sonraki kayıtlar
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
function FinanceRow({
  row: r,
  disabled,
  onOpen,
}: {
  row: FinanceReceivable;
  disabled: boolean;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <tr>
      <th scope="row">
        <button
          type="button"
          className="finance-customer"
          disabled={disabled}
          onClick={onOpen}
          data-panel-trigger={r.id + ':customer'}
        >
          {r.customerName}
        </button>
        <small>{r.policyNumber}</small>
      </th>
      <td data-label="Branş">{r.branchName}</td>
      <td data-label="Alacak" className="finance-money">
        {policyMoney(r.amountMinor, r.currency)}
      </td>
      <td data-label="Tahsilat" className="finance-money">
        {policyMoney(r.collectedMinor, r.currency)}
      </td>
      <td data-label="Kalan" className="finance-money">
        <strong>{policyMoney(r.remainingMinor, r.currency)}</strong>
      </td>
      <td data-label="Ödeme / Vade">
        {financeMethodLabels[r.method]}
        <small>{policyDate(r.dueDate)}</small>
      </td>
      <td data-label="Durum">
        <span className="finance-state" data-state={r.state}>
          {stateLabels[r.state]}
        </span>
      </td>
      <td data-label="İşlem">
        <Button
          variant="outline"
          disabled={disabled}
          onClick={onOpen}
          data-panel-trigger={r.id + ':detail'}
        >
          Detayı aç
        </Button>
      </td>
    </tr>
  );
}

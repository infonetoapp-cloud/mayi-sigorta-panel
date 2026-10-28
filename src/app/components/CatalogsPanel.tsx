import { useState, useEffect, useRef, useCallback, useId } from 'react';
import { getCsrfToken, invalidateCsrfToken } from '../App';
import { NavigationDecision } from './layout/NavigationDecision';
import { registerQuotePopGuard } from '../pages/today-work/quote-navigation';
import './catalog-v4.css';
type Catalog = 'insurers' | 'branches' | 'products' | 'payment-methods' | 'loss-reasons';
interface Item {
  id: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  version: number;
  insurerId?: string;
  branchId?: string;
  dataClassification?: 'GENERAL' | 'HEALTH';
  supportsInstallments?: boolean;
  maxInstallments?: number;
}
interface Draft {
  item: Item | null;
  code: string;
  name: string;
  insurerId: string;
  branchId: string;
  classification: 'GENERAL' | 'HEALTH';
  installments: boolean;
  maxInstallments: string;
}
interface Attempt {
  url: string;
  method: 'POST' | 'PATCH';
  body: string;
  key: string;
  deactivate: boolean;
}
const tabs: [Catalog, string, string][] = [
  ['insurers', 'Sigorta Şirketleri', 'Çalıştığınız sigortacıların ortak listesi'],
  ['branches', 'Branşlar', 'Ürünlerin bağlı olduğu sigorta branşları'],
  ['products', 'Ürünler', 'Sigortacı ve branşa bağlı ürünler'],
  ['payment-methods', 'Ödeme Yöntemleri', 'Peşin ve taksit seçenekleri'],
  ['loss-reasons', 'Kayıp Nedenleri', 'Yenileme sonuçlarında kullanılan nedenler'],
];
const blank = (): Draft => ({
  item: null,
  code: '',
  name: '',
  insurerId: '',
  branchId: '',
  classification: 'GENERAL',
  installments: false,
  maxInstallments: '12',
});
const normalize = (s: string) => s.toLocaleLowerCase('tr-TR');
function errorMessage(status: number, code?: string) {
  if (code === 'CATALOG_RELATION_IN_USE')
    return 'Bu ilişki geçmiş poliçelerde kullanılıyor. Mevcut bağlantıyı değiştirmek yerine yeni ürün oluşturun.';
  if (status === 401) return 'Oturumunuz sona erdi. Yeniden giriş yapın.';
  if (status === 403)
    return 'Bu işlem için katalog yönetimi yetkiniz yok. Erişim sunucuda reddedildi.';
  if (code?.includes('DUPLICATE')) return 'Bu kod zaten kullanılıyor. Başka bir kod seçin.';
  if (status === 409)
    return 'Kayıt değişti veya işlem mevcut ilişkilerle çakışıyor. Taslak korunuyor; güncel kaydı ayrıca yükleyip karşılaştırın.';
  if (status === 404) return 'Kayıt bulunamadı veya erişiminiz değişti.';
  if (status === 400 || status === 422)
    return 'Bilgileri kontrol edin. Kod, ad ve gerekli ilişkiler geçerli olmalıdır; aynı kod tekrar kullanılamaz.';
  return 'Yanıt kesinleşmedi. Aynı isteği yeniden deneyin; yeni bir kayıt göndermeyin.';
}
export function CatalogsPanel() {
  const id = useId(),
    compareGeneration = useRef(0),
    editorTrigger = useRef<HTMLElement | null>(null),
    generation = useRef(0),
    executing = useRef(false),
    risk = useRef({ dirty: false, hold: false }),
    approved = useRef<HTMLAnchorElement | null>(null),
    allowPop = useRef(false),
    initialDraft = useRef('');
  const [active, setActive] = useState<Catalog>('insurers'),
    [inactive, setInactive] = useState(false),
    [items, setItems] = useState<Item[]>([]),
    [all, setAll] = useState<Partial<Record<Catalog, Item[]>>>({}),
    [loading, setLoading] = useState(true),
    [capability, setCapability] = useState<boolean | null>(null),
    [capError, setCapError] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [search, setSearch] = useState(''),
    [insurerFilter, setInsurerFilter] = useState(''),
    [branchFilter, setBranchFilter] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Attempt | null>(null),
    [mutationError, setMutationError] = useState(''),
    [leave, setLeave] = useState<(() => void) | null>(null),
    [deactivate, setDeactivate] = useState<Item | null>(null),
    [comparison, setComparison] = useState<Item | null>(null);
  const form = useRef<HTMLElement>(null);
  const hold = busy || pending !== null;
  const dirty = !!draft && JSON.stringify(draft) !== initialDraft.current;
  risk.current = { dirty, hold };
  function guard(go: () => void) {
    if (risk.current.hold) {
      setMutationError('İşlem sonucu çözülmeden ayrılamazsınız. Aynı isteği yeniden deneyin.');
      return;
    }
    if (risk.current.dirty) setLeave(() => go);
    else go();
  }
  useEffect(() => {
    if (!dirty && !hold) return;
    const stable = { state: history.state, url: location.href };
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const click = (e: MouseEvent) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const a =
        e.target instanceof Element
          ? (e.target.closest('a[href]') as HTMLAnchorElement | null)
          : null;
      if (
        !a ||
        a === approved.current ||
        a.target === '_blank' ||
        new URL(a.href).origin !== location.origin
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      guard(() => {
        approved.current = a;
        try {
          a.click();
        } finally {
          approved.current = null;
        }
      });
    };
    const logout = (e: Event) => {
      e.preventDefault();
      const go = (e as CustomEvent<{ proceed?: () => void }>).detail?.proceed;
      if (go) guard(go);
    };
    document.addEventListener('click', click, true);
    document.addEventListener('mayi-logout-requested', logout);
    addEventListener('beforeunload', unload);
    const off = registerQuotePopGuard((e) => {
      if (allowPop.current) {
        allowPop.current = false;
        return;
      }
      e.stopImmediatePropagation();
      const dest = { state: history.state, url: location.href };
      history.replaceState(stable.state, '', stable.url);
      guard(() => {
        allowPop.current = true;
        history.replaceState(dest.state, '', dest.url);
        dispatchEvent(new PopStateEvent('popstate', { state: dest.state }));
      });
    });
    return () => {
      document.removeEventListener('click', click, true);
      document.removeEventListener('mayi-logout-requested', logout);
      removeEventListener('beforeunload', unload);
      off();
    };
  }, [dirty, hold]);
  const capabilities = useCallback(async () => {
    setCapError(false);
    try {
      const r = await fetch('/api/catalogs/capabilities', { cache: 'no-store' });
      if (!r.ok) throw new Error();
      const j = (await r.json()) as { data: { canManage: boolean } };
      setCapability(j.data.canManage === true);
    } catch {
      setCapability(null);
      setCapError(true);
    }
  }, []);
  const load = useCallback(async () => {
    const n = ++generation.current;
    setLoading(true);
    setError('');
    setItems([]);
    try {
      const r = await fetch(`/api/catalogs/${active}${inactive ? '?include_inactive=true' : ''}`, {
        cache: 'no-store',
      });
      const j = (await r.json()) as { success: boolean; data?: Item[]; error?: { code: string } };
      if (n !== generation.current) return;
      if (!r.ok || !j.success || !j.data) {
        setError(
          r.status >= 500
            ? 'Katalog yüklenemedi. Filtreler korunuyor; yeniden deneyin.'
            : errorMessage(r.status, j.error?.code),
        );
        if (r.status === 401) document.dispatchEvent(new Event('mayi-session-ended'));
        return;
      }
      setItems(j.data);
      setAll((old) => ({ ...old, [active]: j.data }));
    } catch {
      if (n === generation.current)
        setError('Katalog yüklenemedi. Filtreler korunuyor; yeniden deneyin.');
    } finally {
      if (n === generation.current) setLoading(false);
    }
  }, [active, inactive]);
  const relations = useCallback(async () => {
    try {
      const results = await Promise.all(
        ['insurers', 'branches'].map(async (type) => {
          const r = await fetch(`/api/catalogs/${type}?include_inactive=true`, {
            cache: 'no-store',
          });
          if (!r.ok) throw new Error();
          const j = (await r.json()) as { data: Item[] };
          return [type, j.data] as const;
        }),
      );
      setAll((old) => ({ ...old, ...Object.fromEntries(results) }));
    } catch {
      setError('İlişki seçenekleri yüklenemedi. Yeni ürün için listeyi yenileyin.');
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
      compareGeneration.current++;
    };
  }, [load]);
  useEffect(() => {
    void capabilities();
  }, [capabilities]);
  useEffect(() => {
    // Other catalog screens do not render product relationships. Load the
    // authorized choices only when that screen actually needs them.
    if (active === 'products') void relations();
  }, [active, relations]);
  useEffect(() => {
    if (draft) {
      form.current?.scrollIntoView?.({ block: 'start' });
      form.current?.querySelector<HTMLElement>('h2')?.focus();
    }
  }, [!!draft]);
  function start(item: Item | null) {
    guard(() => {
      compareGeneration.current++;
      editorTrigger.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const d: Draft = item
        ? {
            item,
            code: item.code,
            name: item.name,
            insurerId: item.insurerId ?? '',
            branchId: item.branchId ?? '',
            classification: item.dataClassification ?? 'GENERAL',
            installments: item.supportsInstallments ?? false,
            maxInstallments: String(item.maxInstallments ?? 12),
          }
        : blank();
      initialDraft.current = JSON.stringify(d);
      setDraft(d);
      setMutationError('');
      setSuccess('');
      setComparison(null);
      void relations();
    });
  }
  function close() {
    guard(() => {
      compareGeneration.current++;
      setDraft(null);
      setMutationError('');
      setComparison(null);
      editorTrigger.current?.focus();
    });
  }
  async function execute(a: Attempt) {
    if (executing.current) return;
    executing.current = true;
    setBusy(true);
    setMutationError('');
    setSuccess('');
    try {
      const csrf = await getCsrfToken();
      const r = await fetch(a.url, {
        method: a.method,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': a.key,
        },
        body: a.body,
        cache: 'no-store',
      });
      const j = (await r.json()) as { success: boolean; data?: unknown; error?: { code: string } };
      if (!r.ok || !j.success) {
        if (
          r.status === 403 &&
          [
            'EXPIRED_TOKEN',
            'INVALID_CSRF_TOKEN',
            'CSRF_TOKEN_EXPIRED',
            'CSRF_TOKEN_INVALID',
          ].includes(j.error?.code ?? '')
        ) {
          invalidateCsrfToken();
          setPending(a);
          setMutationError('Güvenlik oturumu yenilenmeli. Aynı isteği açıkça yeniden deneyin.');
          return;
        }
        if (r.status >= 500) {
          setPending(a);
        } else {
          setPending(null);
          if (r.status === 403) {
            setCapability(false);
            void capabilities();
          }
          if (r.status === 401) document.dispatchEvent(new Event('mayi-session-ended'));
        }
        setMutationError(errorMessage(r.status, j.error?.code));
        return;
      }
      if (j.data === undefined || j.data === null) throw new Error('RESULT_UNAVAILABLE');
      compareGeneration.current++;
      setPending(null);
      setDraft(null);
      setDeactivate(null);
      setComparison(null);
      setSuccess(
        a.deactivate
          ? 'Kayıt pasifleştirildi. Geçmiş poliçe bağlantıları korunur.'
          : 'Kayıt kaydedildi. Güncel katalog listesi yenilendi.',
      );
      await load();
      await relations();
    } catch {
      setPending(a);
      setMutationError(
        'Yanıt kesinleşmedi. Gövde ve işlem anahtarı donduruldu; yalnız aynı isteği yeniden deneyin.',
      );
    } finally {
      executing.current = false;
      setBusy(false);
    }
  }
  function save() {
    if (!draft || hold || capability !== true) return;
    const body: Record<string, unknown> = draft.item
      ? { expectedVersion: draft.item.version, name: draft.name.trim() }
      : { code: draft.code.trim(), name: draft.name.trim() };
    if (active === 'products') {
      if (!draft.item) body.insurerId = draft.insurerId;
      body.branchId = draft.branchId;
    }
    if (active === 'branches' && !draft.item) body.dataClassification = draft.classification;
    if (active === 'payment-methods') {
      body.supportsInstallments = draft.installments;
      body.maxInstallments = Number(draft.maxInstallments);
    }
    void execute({
      url: `/api/catalogs/${active}${draft.item ? '/' + encodeURIComponent(draft.item.id) : ''}`,
      method: draft.item ? 'PATCH' : 'POST',
      body: JSON.stringify(body),
      key: crypto.randomUUID(),
      deactivate: false,
    });
  }
  const title = tabs.find((t) => t[0] === active)!;
  const visible = items.filter(
    (i) =>
      normalize(
        `${i.name} ${i.code} ${all.insurers?.find((x) => x.id === i.insurerId)?.name ?? ''} ${all.branches?.find((x) => x.id === i.branchId)?.name ?? ''}`,
      ).includes(normalize(search.trim())) &&
      (!insurerFilter || i.insurerId === insurerFilter) &&
      (!branchFilter || i.branchId === branchFilter),
  );
  const relationLabel = (type: Catalog, value?: string) =>
    all[type]?.find((x) => x.id === value)?.name ?? 'İlişki bilgisi yüklenemedi';
  return (
    <section className="catalog-v4" aria-label="Katalog yönetimi">
      <header className="catalog-page-heading">
        <div>
          <span className="catalog-eyebrow">ORTAK SEÇENEKLER</span>
          <h1>Kataloglar</h1>
          <p>Poliçe ve yenilemelerde kullanılan seçenekleri tek yerden düzenleyin.</p>
        </div>
        {capability === true && (
          <button className="catalog-primary" disabled={hold} onClick={() => start(null)}>
            Yeni kayıt
          </button>
        )}
      </header>
      <nav className="catalog-tabs" aria-label="Katalog türü">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={active === key}
            disabled={hold}
            onClick={() =>
              guard(() => {
                setActive(key);
                setSearch('');
                setInsurerFilter('');
                setBranchFilter('');
                setDraft(null);
                setMutationError('');
                setSuccess('');
              })
            }
          >
            {label}
          </button>
        ))}
      </nav>
      {capError && (
        <p className="catalog-alert" role="alert">
          Yönetim yetkisi doğrulanamadı.{' '}
          <button onClick={() => void capabilities()}>Yetkiyi yeniden dene</button>
        </p>
      )}
      {capability === false && (
        <p className="catalog-readonly">
          Salt okunur · Katalogları inceleyebilirsiniz. Ekleme ve düzenleme için Katalog Yönetimi
          izni gerekir.
        </p>
      )}
      {error && (
        <p className="catalog-alert" role="alert">
          {error}{' '}
          <button
            onClick={() => {
              void load();
              void relations();
            }}
          >
            Yeniden dene
          </button>
        </p>
      )}
      {success && (
        <p className="catalog-success" role="status">
          {success}
        </p>
      )}
      <section className="catalog-card">
        <div className="catalog-section-heading">
          <div>
            <h2>{title[1]}</h2>
            <p>{title[2]}</p>
          </div>
          <button
            disabled={hold}
            onClick={() => {
              void load();
              void capabilities();
              void relations();
            }}
          >
            Listeyi yenile
          </button>
        </div>
        <div className="catalog-toolbar">
          <label className="catalog-search">
            Katalogda ara
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Ad, kod veya ilişki"
            />
          </label>
          <label className="catalog-check">
            <input
              type="checkbox"
              checked={inactive}
              disabled={hold}
              onChange={(e) => {
                const checked = e.target.checked;
                guard(() => setInactive(checked));
              }}
            />
            Pasif kayıtları göster
          </label>
          {active === 'products' && (
            <>
              <label>
                Sigortacı filtresi
                <select
                  aria-label="Sigortacı filtresi"
                  value={insurerFilter}
                  onChange={(e) => setInsurerFilter(e.target.value)}
                >
                  <option value="">Tüm sigortacılar</option>
                  {all.insurers?.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Branş filtresi
                <select
                  aria-label="Branş filtresi"
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                >
                  <option value="">Tüm branşlar</option>
                  {all.branches?.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
        <p className="catalog-list-summary">
          {visible.length} / {items.length} yüklenen kayıt · Arama bu kataloğun yüklenen listesinde
          uygulanır.
        </p>
        <div className="catalog-table" aria-busy={loading}>
          <table>
            <thead>
              <tr>
                <th>Ad ve kod</th>
                {active === 'products' && <th>Sigortacı / Branş</th>}
                {active === 'branches' && <th>Veri sınıfı</th>}
                {active === 'payment-methods' && <th>Taksit</th>}
                <th>Durum</th>
                <th>
                  <span className="sr-only">İşlemler</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4}>
                    <p role="status" className="catalog-empty">
                      Katalog yükleniyor…
                    </p>
                  </td>
                </tr>
              ) : (
                visible.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.name}</strong>
                      <small>{item.code}</small>
                    </td>
                    {active === 'products' && (
                      <td>
                        {relationLabel('insurers', item.insurerId)}
                        <small>{relationLabel('branches', item.branchId)}</small>
                      </td>
                    )}
                    {active === 'branches' && (
                      <td>
                        {item.dataClassification === 'HEALTH'
                          ? 'Sağlık · Ek hassas yetki gerekir'
                          : 'Genel'}
                      </td>
                    )}
                    {active === 'payment-methods' && (
                      <td>
                        {item.supportsInstallments
                          ? `En fazla ${item.maxInstallments} taksit`
                          : 'Peşin'}
                      </td>
                    )}
                    <td>
                      <span className={'catalog-status ' + item.status.toLowerCase()}>
                        {item.status === 'ACTIVE' ? 'Etkin' : 'Pasif'}
                      </span>
                    </td>
                    <td>
                      <div className="catalog-row-actions">
                        {capability === true && (
                          <>
                            <button disabled={hold} onClick={() => start(item)}>
                              Düzenle
                            </button>
                            {item.status === 'ACTIVE' && (
                              <button
                                className="catalog-text"
                                disabled={hold}
                                onClick={() =>
                                  guard(() => {
                                    setDeactivate(item);
                                    setMutationError('');
                                  })
                                }
                              >
                                Pasifleştir
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
              {!loading && !visible.length && !error && (
                <tr>
                  <td colSpan={4}>
                    <div className="catalog-empty">
                      <h3>
                        {search || insurerFilter || branchFilter
                          ? 'Aramanızla eşleşen kayıt yok'
                          : 'Bu katalogda kayıt yok'}
                      </h3>
                      <p>
                        {search || insurerFilter || branchFilter
                          ? 'Aramayı veya filtreleri değiştirin.'
                          : 'Yetkiniz varsa ilk kaydı oluşturabilirsiniz.'}
                      </p>
                      {(search || insurerFilter || branchFilter) && (
                        <button
                          onClick={() => {
                            setSearch('');
                            setInsurerFilter('');
                            setBranchFilter('');
                          }}
                        >
                          Filtreleri temizle
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {mutationError && !deactivate && (
        <p className="catalog-alert" role="alert">
          {mutationError}
        </p>
      )}
      {pending && !deactivate && (
        <button className="catalog-primary" disabled={busy} onClick={() => void execute(pending)}>
          Aynı isteği yeniden dene
        </button>
      )}
      {draft && (
        <section
          ref={form}
          className="catalog-editor catalog-card"
          aria-label="Katalog kayıt formu"
        >
          <div className="catalog-section-heading">
            <div>
              <span className="catalog-eyebrow">{title[1]}</span>
              <h2 tabIndex={-1}>{draft.item ? 'Kaydı düzenle' : 'Yeni kayıt oluştur'}</h2>
              <p>
                {draft.item
                  ? 'Kod ve mevcut sigortacı kimliği değişmez.'
                  : 'Kısa bir kod ve çalışanların anlayacağı bir ad kullanın.'}
              </p>
            </div>
            <button disabled={hold} onClick={close}>
              Vazgeç
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <fieldset disabled={hold || capability !== true}>
              <div className="catalog-fields">
                <label htmlFor={id + '-code'}>
                  Kod
                  <input
                    id={id + '-code'}
                    aria-label="Kod"
                    value={draft.code}
                    disabled={!!draft.item}
                    maxLength={50}
                    pattern="[A-Za-z0-9_.-]+"
                    required
                    onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                  />
                  <small>Harf, rakam, nokta, alt çizgi ve tire.</small>
                </label>
                <label htmlFor={id + '-name'}>
                  Ad
                  <input
                    id={id + '-name'}
                    value={draft.name}
                    maxLength={255}
                    required
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                {active === 'products' && (
                  <>
                    <label>
                      Sigorta şirketi
                      <select
                        aria-label="Sigorta şirketi"
                        value={draft.insurerId}
                        disabled={!!draft.item}
                        required
                        onChange={(e) => setDraft({ ...draft, insurerId: e.target.value })}
                      >
                        <option value="">Sigortacı seçin</option>
                        {all.insurers
                          ?.filter((i) => i.status === 'ACTIVE' || i.id === draft.insurerId)
                          .map((i) => (
                            <option key={i.id} value={i.id}>
                              {i.name}
                              {i.status === 'INACTIVE' ? ' · Pasif' : ''}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Branş
                      <select
                        aria-label="Branş"
                        value={draft.branchId}
                        required
                        onChange={(e) => setDraft({ ...draft, branchId: e.target.value })}
                      >
                        <option value="">Branş seçin</option>
                        {all.branches
                          ?.filter((i) => i.status === 'ACTIVE' || i.id === draft.branchId)
                          .map((i) => (
                            <option key={i.id} value={i.id}>
                              {i.name}
                              {i.status === 'INACTIVE' ? ' · Pasif' : ''}
                            </option>
                          ))}
                      </select>
                    </label>
                    <p className="catalog-form-note">
                      Kullanılan ürünün branşı geçmiş poliçe ilişkileri nedeniyle
                      değiştirilemeyebilir. Böyle bir durumda yeni ürün oluşturun; tarihsel kayıtlar
                      yeniden yazılmaz.
                    </p>
                  </>
                )}
                {active === 'branches' && (
                  <label>
                    Veri sınıfı
                    <select
                      value={draft.classification}
                      disabled={!!draft.item}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          classification: e.target.value as Draft['classification'],
                        })
                      }
                    >
                      <option value="GENERAL">Genel</option>
                      <option value="HEALTH">Sağlık — hassas erişim gerektirir</option>
                    </select>
                    <small>Oluşturulduktan sonra sınıf değiştirilemez.</small>
                  </label>
                )}
                {active === 'payment-methods' && (
                  <>
                    <label className="catalog-check">
                      <input
                        type="checkbox"
                        checked={draft.installments}
                        onChange={(e) => setDraft({ ...draft, installments: e.target.checked })}
                      />
                      Taksit destekler
                    </label>
                    <label>
                      En fazla taksit
                      <input
                        type="number"
                        min={2}
                        max={36}
                        required
                        value={draft.maxInstallments}
                        onChange={(e) => setDraft({ ...draft, maxInstallments: e.target.value })}
                      />
                    </label>
                  </>
                )}
              </div>
            </fieldset>
            {draft.item && (
              <div className="catalog-compare">
                <button
                  type="button"
                  disabled={hold}
                  onClick={() => {
                    const request = ++compareGeneration.current;
                    void (async () => {
                      try {
                        const r = await fetch(`/api/catalogs/${active}/${draft.item!.id}`, {
                          cache: 'no-store',
                        });
                        const j = (await r.json()) as { data: Item };
                        if (!r.ok) throw new Error();
                        if (request === compareGeneration.current) setComparison(j.data);
                      } catch {
                        if (request === compareGeneration.current)
                          setMutationError('Güncel kayıt yüklenemedi. Taslak korunuyor.');
                      }
                    })();
                  }}
                >
                  Güncel kaydı karşılaştır
                </button>
                {comparison && (
                  <div>
                    <p>
                      Kaydederken kullanılan ad: {draft.item.name}
                      <br />
                      Sunucudaki güncel ad: {comparison.name}
                      <br />
                      Taslak ad: {draft.name}
                    </p>
                    <button
                      type="button"
                      disabled={hold}
                      onClick={() => {
                        const item = comparison;
                        guard(() => {
                          const d = {
                            ...draft,
                            item,
                            name: item.name,
                            branchId: item.branchId ?? draft.branchId,
                          };
                          initialDraft.current = JSON.stringify(d);
                          setDraft(d);
                          setComparison(null);
                          setMutationError('');
                        });
                      }}
                    >
                      Taslağı bırak ve güncel kaydı aç
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="catalog-form-footer">
              <p>Yalnız sunucu onayı sonrası liste değişir. Pasifleştirme geçmiş kaydı silmez.</p>
              <button className="catalog-primary" disabled={hold || capability !== true}>
                {busy ? 'Kaydediliyor…' : draft.item ? 'Güncelle' : 'Kaydet'}
              </button>
            </div>
          </form>
        </section>
      )}
      {deactivate && (
        <NavigationDecision
          onStay={() => {
            if (!hold) setDeactivate(null);
          }}
        >
          <h2 id="navigation-decision-title">Kayıt pasifleştirilsin mi?</h2>
          <p>{deactivate.name} yeni seçimlerde kullanılamaz. Geçmiş poliçeler silinmez.</p>
          <div className="auth-actions">
            <button disabled={hold} onClick={() => setDeactivate(null)}>
              Vazgeç
            </button>
            <button
              disabled={hold || capability !== true}
              onClick={() =>
                void execute({
                  url: `/api/catalogs/${active}/${deactivate.id}/deactivate`,
                  method: 'POST',
                  body: JSON.stringify({ expectedVersion: deactivate.version }),
                  key: crypto.randomUUID(),
                  deactivate: true,
                })
              }
            >
              Pasifleştirmeyi onayla
            </button>
          </div>
          {mutationError && <p role="alert">{mutationError}</p>}
          {pending && (
            <button disabled={busy} onClick={() => void execute(pending)}>
              Aynı isteği yeniden dene
            </button>
          )}
        </NavigationDecision>
      )}
      {leave && (
        <NavigationDecision onStay={() => setLeave(null)}>
          <h2 id="navigation-decision-title">Kaydedilmemiş taslak bırakılsın mı?</h2>
          <p>Değişiklikleriniz kaydedilmedi. Sunucudaki kayıt bu kararla değişmez.</p>
          <div className="auth-actions">
            <button onClick={() => setLeave(null)}>Bu ekranda kal</button>
            <button
              onClick={() => {
                if (risk.current.hold) return;
                const go = leave;
                setLeave(null);
                go();
              }}
            >
              Ayrılmayı onayla
            </button>
          </div>
        </NavigationDecision>
      )}
    </section>
  );
}

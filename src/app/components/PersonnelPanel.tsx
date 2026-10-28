import { useEffect, useState, useRef } from 'react';
import {
  PERMISSION_CATALOG,
  createOnboardingTemplateGrants,
  type OnboardingTemplateId,
} from '../../shared/permissions';
import { ReauthForm } from '../AuthShell';
import { invalidateCsrfToken } from '../App';
import { authErrorMessage } from '../auth-errors';
import { NavigationDecision } from './layout/NavigationDecision';
import { registerQuotePopGuard } from '../pages/today-work/quote-navigation';
import {
  PermissionEditor,
  PermissionComparison,
  changedGrants,
  type Grant,
} from './PersonnelPermissions';
import './personnel-v4.css';
import { PersonnelBulk } from './PersonnelBulk';
import { WorkflowHelp } from './ui/workflow-help';
import { isFullMember } from '../../shared/full-staff';
interface Person {
  id: string;
  user_id: string;
  display_name: string | null;
  login_email: string | null;
  type: 'OWNER' | 'MEMBER';
  status: string;
  version: number;
  grants: Grant[];
}
interface Attempt {
  command: Record<string, unknown>;
  key: string;
  grantKey: string;
  token?: string;
}
const labels: Record<string, string> = {
  reset: 'Şifre sıfırla',
  permissions: 'İzinleri düzenle',
  suspend: 'Askıya al',
  inactivate: 'Pasifleştir',
  reactivate: 'Yeniden etkinleştir',
  promote: 'Sahip yap',
  demote: 'Personel yap',
  transfer: 'Sahipliği devret',
};
const effects: Record<string, string> = {
  reset:
    'Yeni, tek kullanımlık geçici şifre oluşturulur ve tüm oturumlar kapatılır. İzinler ve pasif üyelik durumu değişmez.',
  permissions:
    'Yalnız aşağıdaki önerilen izinler kaydedilir. Çalışanın açık oturumları kapanır; yeniden girişte güncel erişim uygulanır.',
  suspend:
    'Erişim durur, açık oturumlar kapanır. İşler silinmez ve başka çalışana otomatik aktarılmaz.',
  inactivate:
    'Çalışan işten ayrılmış olarak pasifleştirilir ve oturumları kapanır. Geçmiş ve açık işler korunur; işlerin yeniden atanması acente sahibi tarafından ayrıca yapılır.',
  reactivate:
    'Üyelik etkinleşir; yeni geçici şifre ve zorunlu ilk giriş değişikliği gerekir. Önceki şifreyle erişim açılmaz.',
  promote:
    'Çalışan acente sahibi olur ve olağan acente yetkilerini rolünden alır. Hassas izinler aşağıda ayrıca gösterilir.',
  demote:
    'Sahiplik kaldırılır. Personel başlangıç izinleri aşağıdaki taslakta açıkça incelenir; son etkin sahip sunucu tarafından korunur.',
  transfer:
    'Hedef çalışan sahip olur; işlemi yapan sahip Personel başlangıç izinleriyle çalışan olur. İki tarafın oturumları kapanır. Geçiş atomiktir; son etkin sahip korunur.',
};
const statusLabel = (s: string) =>
  ({ ACTIVE: 'Etkin', SUSPENDED: 'Askıda', INACTIVE: 'Pasif', INVITED: 'Davetli' })[s] ??
  'Bilinmeyen durum';
function TemporaryDialog({ value, onClose }: { value: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState('');
  useEffect(() => {
    ref.current?.showModal?.();
  }, []);
  return (
    <dialog
      ref={ref}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function' ? true : undefined}
      className="personnel-secret-dialog personnel-v4"
      aria-labelledby="temporary-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <span className="personnel-eyebrow">GÜVENLİ TESLİM</span>
      <h2 id="temporary-title">Geçici şifre — yalnız bir kez</h2>
      <p>
        24 saat içinde çalışanla güvenli bir kanaldan paylaşın. İlk girişte çalışan kendi kalıcı
        şifresini belirlemeden CRM verilerine erişemez.
      </p>
      <output className="temporary-secret" data-sensitive="true">
        {value}
      </output>
      <p className="personnel-muted">
        Ekran görüntüsü veya not almayın. Bu pencere kapandığında şifre tekrar getirilemez;
        gerekirse yeni güvenli sıfırlama yapılır.
      </p>
      <p role="status">{copied}</p>
      <div className="auth-actions">
        <button
          onClick={() => {
            void navigator.clipboard.writeText(value).then(
              () => setCopied('Panoya kopyalandı.'),
              () => setCopied('Panoya erişilemedi. Güvenli paylaşımı elle tamamlayın.'),
            );
          }}
        >
          Kopyala
        </button>
        <button className="personnel-primary" onClick={onClose}>
          Güvenli biçimde kapat
        </button>
      </div>
    </dialog>
  );
}
export function PersonnelPanel() {
  const listGeneration = useRef(0),
    attempt = useRef<Attempt | null>(null),
    allowPop = useRef(false),
    executing = useRef(false),
    editor = useRef<HTMLElement>(null),
    risk = useRef({ dirty: false, hold: false });
  const [cursor, setCursor] = useState<string | null>(null),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [previous, setPrevious] = useState<(string | null)[]>([]);
  const [compact, setCompact] = useState(() => innerWidth <= 900);
  useEffect(() => {
    const resize = () => setCompact(innerWidth <= 900);
    addEventListener('resize', resize);
    return () => removeEventListener('resize', resize);
  }, []);
  const [items, setItems] = useState<Person[]>([]),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [notice, setNotice] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [search, setSearch] = useState(''),
    [appliedSearch, setAppliedSearch] = useState('');
  const [create, setCreate] = useState(false),
    [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [template, setTemplate] = useState<OnboardingTemplateId>('personel'),
    [grants, setGrants] = useState<Grant[]>(() => [...createOnboardingTemplateGrants('personel')]);
  const [selected, setSelected] = useState<{ person: Person; kind: string } | null>(null),
    [reason, setReason] = useState(''),
    [reauth, setReauth] = useState(false),
    [temporary, setTemporary] = useState<string | null>(null),
    [leave, setLeave] = useState<(() => void) | null>(null),
    [confirmed, setConfirmed] = useState(false);
  const dirty = create
    ? !!name ||
      !!email ||
      template !== 'personel' ||
      changedGrants([...createOnboardingTemplateGrants('personel')], grants).length > 0
    : !!selected && (!!reason || changedGrants(selected.person.grants, grants).length > 0);
  const hold = busy || uncertain || reauth || temporary !== null;
  risk.current = { dirty, hold };
  function guard(action: () => void) {
    if (risk.current.hold) {
      setNotice(
        'Sonuç kesinleşmeden bu işlemden ayrılamazsınız. Önce aynı isteği kurtarın veya güvenli şifre penceresini kapatın.',
      );
      return;
    }
    if (risk.current.dirty) setLeave(() => action);
    else action();
  }
  useEffect(() => {
    if (!dirty && !hold) return;
    let approved: HTMLAnchorElement | null = null;
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
        a === approved ||
        a.target === '_blank' ||
        new URL(a.href).origin !== location.origin
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      guard(() => {
        approved = a;
        try {
          a.click();
        } finally {
          approved = null;
        }
      });
    };
    const logout = (e: Event) => {
      e.preventDefault();
      const proceed = (e as CustomEvent<{ proceed?: () => void }>).detail?.proceed;
      if (proceed) guard(proceed);
    };
    document.addEventListener('click', click, true);
    document.addEventListener('mayi-logout-requested', logout);
    addEventListener('beforeunload', unload);
    const off = registerQuotePopGuard((event) => {
      if (allowPop.current) {
        allowPop.current = false;
        return;
      }
      event.stopImmediatePropagation();
      const destination = { state: history.state, url: location.href };
      history.replaceState(stable.state, '', stable.url);
      guard(() => {
        allowPop.current = true;
        history.replaceState(destination.state, '', destination.url);
        dispatchEvent(new PopStateEvent('popstate', { state: destination.state }));
      });
    });
    return () => {
      document.removeEventListener('click', click, true);
      document.removeEventListener('mayi-logout-requested', logout);
      removeEventListener('beforeunload', unload);
      off();
    };
  }, [dirty, hold]);
  useEffect(() => {
    if (create || selected) {
      editor.current?.scrollIntoView?.({ block: 'start' });
      editor.current?.querySelector<HTMLElement>('h2')?.focus();
    }
  }, [create, selected]);
  async function refresh(pageCursor: string | null = cursor, query = appliedSearch) {
    const generation = ++listGeneration.current;
    setLoading(true);
    setItems([]);
    setNextCursor(null);
    setError('');
    try {
      const params = new URLSearchParams({ page_size: '50' });
      if (pageCursor) params.set('cursor', pageCursor);
      if (query.trim()) params.set('search', query.trim());
      const response = await fetch('/api/personnel?' + params, { cache: 'no-store' });
      const data = (await response.json()) as {
        data?: { personnel: Person[]; nextCursor: string | null };
        error?: { code?: string };
      };
      if (generation !== listGeneration.current) return;
      if (!response.ok) {
        setError(authErrorMessage(data.error?.code, response.status));
        if (response.status === 401) document.dispatchEvent(new Event('mayi-session-ended'));
        return;
      }
      setItems(data.data?.personnel ?? []);
      setNextCursor(data.data?.nextCursor ?? null);
    } catch {
      if (generation === listGeneration.current)
        setError('Personel listesi yüklenemedi. Filtreyi koruyarak yeniden deneyin.');
    } finally {
      if (generation === listGeneration.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      listGeneration.current++;
    };
  }, []);
  async function execute(command: Record<string, unknown>, retry = false) {
    if (executing.current) return;
    const active = retry
      ? attempt.current
      : ({
          command: JSON.parse(JSON.stringify(command)) as Record<string, unknown>,
          key: crypto.randomUUID(),
          grantKey: crypto.randomUUID(),
        } as Attempt);
    if (!active) return;
    attempt.current = active;
    executing.current = true;
    setBusy(true);
    setError('');
    setSuccess('');
    setNotice('');
    setUncertain(false);
    try {
      const csrfRes = await fetch('/api/auth/csrf-token', { cache: 'no-store' });
      const csrf = (await csrfRes.json()) as { data?: { token: string } };
      if (csrfRes.status === 401) {
        attempt.current = null;
        document.dispatchEvent(new Event('mayi-session-ended'));
        return;
      }
      if (!csrfRes.ok || !csrf.data) throw new Error('CSRF_UNAVAILABLE');
      const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf.data.token };
      if (!active.token) {
        const gr = await fetch('/secure/api/personnel/grants', {
          method: 'POST',
          headers: { ...headers, 'idempotency-key': active.grantKey },
          body: JSON.stringify(active.command),
          cache: 'no-store',
        });
        if (gr.status === 401) {
          setReauth(true);
          return;
        }
        const grant = (await gr.json()) as {
          data?: { grantEvidenceToken: string };
          error?: { code: string };
        };
        if (!gr.ok) {
          if (gr.status >= 500) throw new Error('NETWORK_UNKNOWN');
          attempt.current = null;
          setError(authErrorMessage(grant.error?.code, gr.status));
          return;
        }
        if (!grant.data?.grantEvidenceToken) throw new Error('NETWORK_UNKNOWN');
        active.token = grant.data.grantEvidenceToken;
      }
      const response = await fetch('/secure/api/personnel/commands', {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': active.key },
        body: JSON.stringify({ command: active.command, grantEvidenceToken: active.token }),
        cache: 'no-store',
      });
      const result = (await response.json()) as {
        data?: { temporaryPassword?: string };
        error?: { code: string };
      };
      if (!response.ok) {
        if (response.status >= 500) throw new Error('NETWORK_UNKNOWN');
        attempt.current = null;
        if (result.error?.code === 'ONE_TIME_RESPONSE_UNAVAILABLE') {
          setCreate(false);
          setSelected(null);
          await refresh();
          setError(
            'İşlem sunucuda tamamlandı; tek seferlik şifre yanıtı yeniden gösterilemez. Hedef kaydı listede doğrulayın ve gerekiyorsa yeni açık onayla şifre sıfırlayın.',
          );
          return;
        }
        setError(
          result.error?.code === 'CONFLICT'
            ? 'Kayıt başka bir işlemle değişti. Taslak korunuyor; listeyi yenileyip kişiyi yeniden seçmeden eski sürümü kaydetmeyin.'
            : authErrorMessage(result.error?.code, response.status),
        );
        return;
      }
      if (!result.data) throw new Error('NETWORK_UNKNOWN');
      attempt.current = null;
      setTemporary(result.data.temporaryPassword ?? null);
      setCreate(false);
      setSelected(null);
      setReason('');
      setName('');
      setEmail('');
      setSuccess('İşlem sunucu tarafından onaylandı. Güncel personel listesi yenilendi.');
      invalidateCsrfToken();
      await refresh();
    } catch {
      setUncertain(true);
      setError(
        'Yanıt kesinleşmedi. Taslak ve işlem anahtarları bellekte donduruldu; aynı isteği yeniden deneyin. Listeyi yenilemek tek başına işlemi tamamlanmış saymaz.',
      );
    } finally {
      executing.current = false;
      setBusy(false);
    }
  }
  function closeEditor() {
    guard(() => {
      setCreate(false);
      setSelected(null);
      setReason('');
      setNotice('');
    });
  }
  function choose(person: Person, kind: string) {
    guard(() => {
      setSelected({ person, kind });
      setCreate(false);
      setReason('');
      setConfirmed(false);
      setError('');
      setSuccess('');
      setGrants(
        kind === 'promote'
          ? person.grants.filter(
              (g) =>
                PERMISSION_CATALOG.find((p) => p.code === g.permission_code)?.classification ===
                'SENSITIVE',
            )
          : kind === 'demote'
            ? [...createOnboardingTemplateGrants('personel')]
            : person.grants.map((g) => ({ ...g })),
      );
    });
  }
  const reasonField = selected && (
    <label>
      Gerekçe
      {selected.kind === 'permissions' && <small>İsteğe bağlı — boş bırakabilirsiniz.</small>}
      <textarea
        aria-label="Gerekçe"
        value={reason}
        minLength={selected.kind === 'permissions' ? 1 : 3}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        required={selected.kind !== 'permissions'}
      />
    </label>
  );
  return (
    <section className="personnel-page personnel-v4" aria-label="Personel yönetimi">
      <header className="personnel-page-heading">
        <div>
          <span className="personnel-eyebrow">EKİP YÖNETİMİ</span>
          <h1>Personel ve İzinler</h1>
        </div>
        <button
          className="personnel-primary"
          disabled={hold}
          onClick={() =>
            guard(() => {
              setCreate(true);
              setSelected(null);
              setName('');
              setEmail('');
              setTemplate('personel');
              setGrants([...createOnboardingTemplateGrants('personel')]);
              setError('');
              setSuccess('');
            })
          }
        >
          Personel oluştur
        </button>
      </header>
      <div className="personnel-context">
        <span>
          <i /> Yalnız acente sahibi yönetebilir
        </span>
      </div>
      {error && (
        <p role="alert" className="personnel-alert">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="personnel-success">
          {success}
        </p>
      )}
      {notice && (
        <p role="status" className="personnel-alert">
          {notice}
        </p>
      )}
      {uncertain && (
        <button onClick={() => void execute({}, true)} disabled={busy}>
          Aynı isteği yeniden dene
        </button>
      )}
      <section className="personnel-roster" aria-label="Çalışan listesi">
        <div className="personnel-toolbar">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              guard(() => {
                setAppliedSearch(search);
                setCursor(null);
                setPrevious([]);
                void refresh(null, search);
              });
            }}
          >
            <label className="personnel-search">
              <span>Personel ara</span>
              <input
                type="search"
                value={search}
                maxLength={120}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Ad veya giriş e-postası"
                disabled={hold}
              />
            </label>
            <button disabled={hold || loading}>Ara</button>
          </form>
          <span className="personnel-muted">Bu sayfada {items.length} çalışan</span>
          <button disabled={hold} onClick={() => void refresh()}>
            Listeyi yenile
          </button>
        </div>
        {appliedSearch && (
          <p className="personnel-filter">
            Arama: {appliedSearch}{' '}
            <button
              disabled={hold}
              onClick={() =>
                guard(() => {
                  setSearch('');
                  setAppliedSearch('');
                  setCursor(null);
                  setPrevious([]);
                  void refresh(null, '');
                })
              }
            >
              Aramayı temizle
            </button>
          </p>
        )}
        <div className="personnel-table" aria-busy={loading}>
          <table>
            <thead>
              <tr>
                <th>Çalışan</th>
                <th>Durum</th>
                <th>Rol ve erişim</th>
                <th>
                  <span className="sr-only">İşlemler</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4}>
                    <p role="status" className="personnel-loading">
                      Çalışanlar yükleniyor…
                    </p>
                  </td>
                </tr>
              ) : (
                items.map((person) => (
                  <tr key={person.id} data-selected={selected?.person.id === person.id}>
                    <td>
                      <div className="personnel-identity">
                        <span className="personnel-avatar" aria-hidden="true">
                          {(person.display_name ?? '?')
                            .split(' ')
                            .slice(0, 2)
                            .map((s) => s[0])
                            .join('')}
                        </span>
                        <div>
                          <strong>{person.display_name ?? 'Tarihsel çalışan'}</strong>
                          <small>{person.login_email ?? 'Yerel giriş henüz kurulmadı'}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={'personnel-status ' + person.status.toLowerCase()}>
                        <i />
                        {statusLabel(person.status)}
                      </span>
                    </td>
                    <td>
                      <strong>{person.type === 'OWNER' ? 'Acente Sahibi' : 'Personel'}</strong>
                      <small>
                        {person.type === 'OWNER'
                          ? 'Olağan yetkiler rolünden gelir'
                          : isFullMember(person.grants)
                            ? 'Tam operasyonel yetki · Çalışan'
                            : `${person.grants.length} kayıtlı izin · Özel erişim`}
                      </small>
                    </td>
                    <td className="personnel-actions">
                      <button disabled={hold} onClick={() => choose(person, 'permissions')}>
                        İzinleri düzenle
                      </button>
                      <details
                        onToggle={(e) => {
                          const details = e.currentTarget;
                          if (!details.open) return;
                          const anchor = details.querySelector('summary')!.getBoundingClientRect();
                          const menu =
                            details.querySelector<HTMLElement>('.personnel-action-menu')!;
                          Object.assign(menu.style, {
                            position: 'fixed',
                            left:
                              Math.max(8, Math.min(anchor.right - 220, innerWidth - 228)) + 'px',
                            top: Math.max(8, Math.min(anchor.bottom + 6, innerHeight - 330)) + 'px',
                            right: 'auto',
                            maxHeight: '310px',
                            overflowY: 'auto',
                          });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            e.currentTarget.open = false;
                            e.currentTarget.querySelector('summary')?.focus();
                          }
                        }}
                      >
                        <summary aria-label={`${person.display_name ?? 'Çalışan'} hesap işlemleri`}>
                          Hesap işlemleri
                        </summary>
                        <div className="personnel-action-menu">
                          <span>Güvenlik ve yaşam döngüsü</span>
                          {[
                            'reset',
                            ...(person.status === 'ACTIVE'
                              ? [
                                  'suspend',
                                  'inactivate',
                                  person.type === 'MEMBER' ? 'promote' : 'demote',
                                  ...(person.type === 'MEMBER' ? ['transfer'] : []),
                                ]
                              : ['reactivate']),
                          ].map((kind) => (
                            <button
                              key={kind}
                              disabled={hold}
                              onClick={(e) => {
                                e.currentTarget.closest('details')?.removeAttribute('open');
                                choose(person, kind);
                              }}
                            >
                              {labels[kind]}
                            </button>
                          ))}
                        </div>
                      </details>
                    </td>
                  </tr>
                ))
              )}
              {!loading && !items.length && (
                <tr>
                  <td colSpan={4}>
                    <div className="personnel-empty">
                      <h2>
                        {appliedSearch
                          ? 'Aramanızla eşleşen çalışan yok'
                          : 'Bu sayfada çalışan bulunamadı'}
                      </h2>
                      <p>
                        {appliedSearch
                          ? 'Adı veya e-postayı kontrol edin; diğer sayfalara bağlı olmayan sunucu araması kullanılır.'
                          : 'Yeni personel oluşturabilir veya listeyi yeniden yükleyebilirsiniz.'}
                      </p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <nav aria-label="Personel sayfaları" className="personnel-pagination">
          <span>Sayfa {previous.length + 1} · En fazla 50 kayıt</span>
          <div>
            <button
              disabled={!previous.length || hold || loading}
              onClick={() =>
                guard(() => {
                  const page = previous.at(-1) ?? null;
                  setPrevious(previous.slice(0, -1));
                  setCursor(page);
                  void refresh(page);
                })
              }
            >
              Önceki sayfa
            </button>
            <button
              disabled={!nextCursor || hold || loading}
              onClick={() =>
                guard(() => {
                  if (!nextCursor) return;
                  setPrevious([...previous, cursor]);
                  setCursor(nextCursor);
                  void refresh(nextCursor);
                })
              }
            >
              Sonraki sayfa
            </button>
          </div>
        </nav>
      </section>
      {(create || selected) && (
        <section ref={editor} className="personnel-workspace" aria-label="Personel işlem alanı">
          <div className="personnel-editor-heading">
            <div>
              <span className="personnel-eyebrow">
                {create
                  ? 'YENİ ÇALIŞAN'
                  : selected?.kind === 'permissions'
                    ? 'ERİŞİM DÜZENLEME'
                    : 'KRİTİK İŞLEM'}
              </span>
              <h2 tabIndex={-1}>
                {create
                  ? 'Yeni personel'
                  : selected?.kind === 'permissions'
                    ? 'Personel işlem onayı'
                    : labels[selected!.kind]}
              </h2>
              <p>
                {create
                  ? 'Kimliği ve başlangıç erişimini birlikte inceleyin.'
                  : `${selected!.person.display_name ?? 'Tarihsel çalışan'} · ${selected!.person.login_email ?? 'Yerel giriş kurulmadı'}`}
              </p>
            </div>
            <button type="button" disabled={hold} onClick={closeEditor}>
              Vazgeç
            </button>
          </div>
          {(create ||
            (selected && ['permissions', 'promote', 'demote'].includes(selected.kind))) && (
            <fieldset className="personnel-bulk" disabled={hold}>
              <PersonnelBulk
                grants={grants}
                onChange={setGrants}
                owner={
                  selected?.kind === 'promote' ||
                  (selected?.kind === 'permissions' && selected.person.type === 'OWNER')
                }
              />
            </fieldset>
          )}
          <form
            className="personnel-editor-grid"
            onSubmit={(e) => {
              e.preventDefault();
              if (create) {
                void execute({ kind: 'create', name, email, template, grants });
                return;
              }
              const command: Record<string, unknown> = {
                kind: selected!.kind,
                targetId: selected!.person.id,
                expectedVersion: selected!.person.version,
                reason,
              };
              if (['permissions', 'promote', 'demote'].includes(selected!.kind))
                command.grants = grants;
              if (selected!.kind === 'transfer') {
                command.oldOwnerGrants = [...createOnboardingTemplateGrants('personel')];
                command.newOwnerGrants = selected!.person.grants.filter(
                  (g) =>
                    PERMISSION_CATALOG.find((p) => p.code === g.permission_code)?.classification ===
                    'SENSITIVE',
                );
              }
              void execute(command);
            }}
          >
            <fieldset className="personnel-fields" disabled={hold}>
              {create && (
                <section className="personnel-card">
                  <h3>Çalışan bilgileri</h3>
                  <div className="personnel-identity-fields">
                    <label>
                      Ad soyad
                      <input
                        value={name}
                        maxLength={120}
                        onChange={(e) => setName(e.target.value)}
                        required
                        autoComplete="off"
                      />
                    </label>
                    <label>
                      Giriş e-postası
                      <input
                        type="email"
                        value={email}
                        maxLength={254}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        autoComplete="off"
                      />
                    </label>
                  </div>
                  <label>
                    Başlangıç şablonu
                    <select
                      value={template}
                      onChange={(e) => {
                        const t = e.target.value as OnboardingTemplateId;
                        setTemplate(t);
                        setGrants([...createOnboardingTemplateGrants(t)]);
                      }}
                    >
                      <option value="personel">Personel</option>
                      <option value="yetkili_personel">Yetkili Personel</option>
                    </select>
                  </label>
                  <p className="personnel-muted">
                    Yalnız bu yeni kişinin başlangıç taslağıdır. Mevcut çalışanların izinleri
                    değişmez; aşağıdaki izinleri kişiye göre düzenleyebilirsiniz.
                  </p>
                </section>
              )}
              {selected && (
                <section
                  className={
                    'personnel-card ' +
                    (selected.kind === 'permissions' ? '' : 'personnel-critical')
                  }
                >
                  <h3>
                    {selected.kind === 'permissions'
                      ? 'Erişim değişikliğinin etkisi'
                      : 'Bu işlem neyi değiştirecek?'}
                  </h3>
                  <p>{effects[selected.kind]}</p>
                  {selected.person.type === 'OWNER' && (
                    <p>
                      Son etkin sahip kaldırılamaz. Sahiplik korunması ve güncel uygunluk sunucuda
                      tekrar doğrulanır.
                    </p>
                  )}
                  {selected.kind === 'permissions' ? (
                    <WorkflowHelp title="Gerekçe ekle (isteğe bağlı)">{reasonField}</WorkflowHelp>
                  ) : (
                    reasonField
                  )}
                  {selected.kind !== 'permissions' && (
                    <label className="personnel-confirm">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(e) => setConfirmed(e.target.checked)}
                        required
                      />
                      Kritik işlem etkilerini okudum ve onaylıyorum
                    </label>
                  )}
                </section>
              )}
              {selected?.kind === 'permissions' && selected.person.type === 'MEMBER' && (
                <section className="personnel-card personnel-template">
                  <h3>Standart erişim şablonu</h3>
                  <p>Taslağa eklenir; hassas izinler otomatik eklenmez.</p>
                  <button
                    type="button"
                    onClick={() =>
                      setGrants((current) => {
                        const m = new Map(current.map((g) => [g.permission_code, g]));
                        for (const g of createOnboardingTemplateGrants('personel'))
                          m.set(g.permission_code, g);
                        return [...m.values()];
                      })
                    }
                  >
                    Standart ortak çalışma izinlerini taslağa uygula
                  </button>
                </section>
              )}
              {(create ||
                (selected && ['permissions', 'promote', 'demote'].includes(selected.kind))) && (
                <PermissionEditor
                  grants={grants}
                  onChange={setGrants}
                  owner={
                    selected?.kind === 'promote' ||
                    (selected?.kind === 'permissions' && selected.person.type === 'OWNER')
                  }
                />
              )}
            </fieldset>
            <aside className="personnel-review">
              <section className="personnel-card">
                {(create ||
                  (selected && ['permissions', 'promote', 'demote'].includes(selected.kind))) && (
                  <PermissionComparison
                    before={create ? [] : selected!.person.grants}
                    after={grants}
                  />
                )}
                <h3>Güvenli onay</h3>
                <p>
                  {create
                    ? 'Geçici şifre yalnız bir kez gösterilir. İlk giriş ve zorunlu şifre değişimi çalışana aittir.'
                    : 'Güncel kayıt sürümü ve yetki sunucuda doğrulanır. Çakışma varsa taslak otomatik birleştirilmez.'}
                </p>
                {selected?.kind === 'transfer' && (
                  <p>
                    Devreden: Personel başlangıç izinleri.
                    <br />
                    Hedef: Acente Sahibi; mevcut hassas izinleri korunur.
                  </p>
                )}
                {!compact && (
                  <button
                    className={
                      selected && selected.kind !== 'permissions'
                        ? 'personnel-danger'
                        : 'personnel-primary'
                    }
                    disabled={hold}
                    type="submit"
                  >
                    {busy
                      ? 'Sunucu sonucu doğrulanıyor…'
                      : create
                        ? 'Onayla ve oluştur'
                        : selected?.kind === 'permissions'
                          ? 'Kaydet'
                          : 'İşlemi onayla'}
                  </button>
                )}
                <p className="personnel-muted">
                  Kaydetme, kendi şifrenizle yeniden doğrulama gerektirebilir.
                </p>
              </section>
            </aside>
            {compact && (
              <div className="personnel-mobile-save">
                <span>
                  Güvenli onay
                  <br />
                  <small>Sunucu doğrulaması gerekli</small>
                </span>
                <button
                  type="submit"
                  className={
                    selected && selected.kind !== 'permissions'
                      ? 'personnel-danger'
                      : 'personnel-primary'
                  }
                  disabled={hold}
                >
                  {busy
                    ? 'Sonuç doğrulanıyor…'
                    : create
                      ? 'Onayla ve oluştur'
                      : selected?.kind === 'permissions'
                        ? 'Kaydet'
                        : 'İşlemi onayla'}
                </button>
              </div>
            )}
          </form>
        </section>
      )}
      {leave && (
        <NavigationDecision onStay={() => setLeave(null)}>
          <h2 id="navigation-decision-title">Kaydedilmemiş taslak bırakılsın mı?</h2>
          <p>
            Kaydedilmemiş personel veya izin taslağı bırakılacak. Sunucudaki izinler bu kararla
            değişmez.
          </p>
          <div className="auth-actions">
            <button onClick={() => setLeave(null)}>Bu ekranda kal</button>
            <button
              onClick={() => {
                if (risk.current.hold) {
                  setLeave(null);
                  setNotice('İstek sonucu çözülmeden ayrılamazsınız.');
                  return;
                }
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
      {reauth && (
        <ReauthForm
          onCancel={() => {
            setReauth(false);
            attempt.current = null;
          }}
          onSuccess={() => {
            setReauth(false);
            void execute({}, true);
          }}
        />
      )}
      {temporary !== null && (
        <TemporaryDialog value={temporary} onClose={() => setTemporary(null)} />
      )}
    </section>
  );
}

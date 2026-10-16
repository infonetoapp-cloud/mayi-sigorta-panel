import { useEffect, useState, useRef } from 'react';
import {
  PERMISSION_CATALOG,
  createOnboardingTemplateGrants,
  type OnboardingTemplateId,
} from '../../shared/permissions';
import { ReauthForm } from '../AuthShell';
import { invalidateCsrfToken } from '../App';
import { authErrorMessage } from '../auth-errors';
interface Grant {
  permission_code: string;
  scope: 'UNSCOPED' | 'ASSIGNED' | 'AGENCY';
}
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
function PermissionEditor({
  grants,
  onChange,
  owner = false,
}: {
  grants: Grant[];
  onChange: (g: Grant[]) => void;
  owner?: boolean;
}) {
  return (
    <div className="permission-list">
      {PERMISSION_CATALOG.filter((p) => !owner || p.classification === 'SENSITIVE').map((p) => {
        const g = grants.find((x) => x.permission_code === p.code);
        return (
          <label key={p.code} className="permission-row">
            <span>
              <input
                type="checkbox"
                checked={!!g}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [
                          ...grants,
                          {
                            permission_code: p.code,
                            scope: p.scopeKind === 'UNSCOPED' ? 'UNSCOPED' : 'ASSIGNED',
                          },
                        ]
                      : grants.filter((x) => x.permission_code !== p.code),
                  )
                }
              />
              {p.title}
              <small>
                {p.description}
                {p.dependencies.length > 0 && ` · Önkoşul: ${p.dependencies.join(', ')}`}
              </small>
            </span>
            {p.scopeKind === 'RECORD_SCOPED' && g && (
              <select
                aria-label={`${p.title} kapsamı`}
                value={g.scope}
                onChange={(e) =>
                  onChange(
                    grants.map((x) =>
                      x.permission_code === p.code
                        ? { ...x, scope: e.target.value as Grant['scope'] }
                        : x,
                    ),
                  )
                }
              >
                <option value="ASSIGNED">Atanan kayıtlar</option>
                <option value="AGENCY">Acente geneli</option>
              </select>
            )}
          </label>
        );
      })}
    </div>
  );
}
export function PersonnelPanel() {
  const listGeneration = useRef(0);
  const [cursor, setCursor] = useState<string | null>(null),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [previous, setPrevious] = useState<(string | null)[]>([]);
  const [items, setItems] = useState<Person[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [create, setCreate] = useState(false),
    [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [template, setTemplate] = useState<OnboardingTemplateId>('personel'),
    [grants, setGrants] = useState<Grant[]>(() => [...createOnboardingTemplateGrants('personel')]);
  const [selected, setSelected] = useState<{ person: Person; kind: string } | null>(null),
    [reason, setReason] = useState(''),
    [reauth, setReauth] = useState(false),
    [pending, setPending] = useState<Record<string, unknown> | null>(null),
    [temporary, setTemporary] = useState<string | null>(null);
  async function refresh(pageCursor: string | null = cursor) {
    const generation = ++listGeneration.current;
    setItems([]);
    setError('');
    setNextCursor(null);
    try {
      const response = await fetch(
        `/api/personnel?page_size=50${pageCursor ? `&cursor=${encodeURIComponent(pageCursor)}` : ''}`,
        { cache: 'no-store' },
      );
      const data = (await response.json()) as {
        data?: { personnel: Person[]; nextCursor: string | null };
        error?: { code?: string };
      };
      if (generation !== listGeneration.current) return;
      if (!response.ok) {
        setError(authErrorMessage(data.error?.code, response.status));
        return;
      }
      setItems(data.data?.personnel ?? []);
      setNextCursor(data.data?.nextCursor ?? null);
    } catch {
      if (generation === listGeneration.current) setError('Personel listesi yüklenemedi.');
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      listGeneration.current++;
    };
  }, []);
  async function execute(command: Record<string, unknown>) {
    setBusy(true);
    setError('');
    const key = crypto.randomUUID();
    try {
      const csrfRes = await fetch('/api/auth/csrf-token', { cache: 'no-store' });
      const csrf = (await csrfRes.json()) as { data: { token: string } };
      if (!csrfRes.ok) throw new Error('Oturum yenilenmeli.');
      const headers = {
        'content-type': 'application/json',
        'x-csrf-token': csrf.data.token,
        'idempotency-key': `grant-${key}`,
      };
      const grantRes = await fetch('/secure/api/personnel/grants', {
        method: 'POST',
        headers,
        body: JSON.stringify(command),
        cache: 'no-store',
      });
      if (grantRes.status === 401) {
        setPending(command);
        setReauth(true);
        return;
      }
      const grant = (await grantRes.json()) as {
        data?: { grantEvidenceToken: string };
        error?: { code?: string };
      };
      if (!grantRes.ok || !grant.data)
        throw new Error(authErrorMessage(grant.error?.code, grantRes.status));
      const response = await fetch('/secure/api/personnel/commands', {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': key },
        body: JSON.stringify({ command, grantEvidenceToken: grant.data.grantEvidenceToken }),
        cache: 'no-store',
      });
      const result = (await response.json()) as {
        data?: { temporaryPassword?: string };
        error?: { code?: string };
      };
      if (!response.ok) throw new Error(authErrorMessage(result.error?.code, response.status));
      setTemporary(result.data?.temporaryPassword ?? null);
      setCreate(false);
      setSelected(null);
      setReason('');
      setName('');
      setEmail('');
      setPending(null);
      invalidateCsrfToken();
      await refresh();
    } catch (err) {
      setError(
        `${err instanceof Error ? err.message : 'Yanıt alınamadı.'} Geçici şifre yanıtı kaybolduysa geri getirilemez; listeyi yenileyip yeni onayla sıfırlayın.`,
      );
      setPending(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="personnel-page">
      <header>
        <div>
          <h1>Personel ve İzinler</h1>
          <p>
            Giriş e-postası değişmez. İzinler şablondan bağımsız kişi kaydıdır; çalışan sayısı
            sınırı yoktur.
          </p>
        </div>
        <button
          onClick={() => {
            setCreate(true);
            setSelected(null);
            setGrants([...createOnboardingTemplateGrants('personel')]);
          }}
        >
          Personel oluştur
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      <div className="personnel-table">
        <table>
          <thead>
            <tr>
              <th>Ad / Giriş e-postası</th>
              <th>Üyelik / Durum</th>
              <th>İşlemler</th>
            </tr>
          </thead>
          <tbody>
            {items.map((person) => (
              <tr key={person.id}>
                <td>
                  {person.display_name ?? 'Tarihsel çalışan'}
                  <small>{person.login_email ?? 'Yerel giriş henüz kurulmadı'}</small>
                </td>
                <td>
                  {person.type === 'OWNER' ? 'Acente Sahibi' : 'Personel'} · {person.status}
                </td>
                <td className="personnel-actions">
                  {[
                    'reset',
                    'permissions',
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
                      onClick={() => {
                        setSelected({ person, kind });
                        setCreate(false);
                        setReason('');
                        setGrants(
                          kind === 'promote'
                            ? person.grants.filter(
                                (g) =>
                                  PERMISSION_CATALOG.find((p) => p.code === g.permission_code)
                                    ?.classification === 'SENSITIVE',
                              )
                            : kind === 'demote'
                              ? [...createOnboardingTemplateGrants('personel')]
                              : person.grants,
                        );
                      }}
                    >
                      {
                        {
                          reset: 'Şifre sıfırla',
                          permissions: 'İzinleri düzenle',
                          suspend: 'Askıya al',
                          inactivate: 'Pasifleştir',
                          reactivate: 'Yeniden etkinleştir',
                          promote: 'Sahip yap',
                          demote: 'Personel yap',
                          transfer: 'Sahipliği devret',
                        }[kind]
                      }
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav aria-label="Personel sayfaları" className="auth-actions">
        <button
          disabled={previous.length === 0 || busy}
          onClick={() => {
            const page = previous.at(-1) ?? null;
            setPrevious(previous.slice(0, -1));
            setCursor(page);
            void refresh(page);
          }}
        >
          Önceki sayfa
        </button>
        <button
          disabled={!nextCursor || busy}
          onClick={() => {
            if (!nextCursor) return;
            setPrevious([...previous, cursor]);
            setCursor(nextCursor);
            void refresh(nextCursor);
          }}
        >
          Sonraki sayfa
        </button>
        <button disabled={busy} onClick={() => void refresh()}>
          Listeyi yenile
        </button>
      </nav>
      {create && (
        <section className="auth-card personnel-form">
          <h2>Yeni personel</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void execute({ kind: 'create', name, email, template, grants });
            }}
          >
            <label>
              Ad soyad
              <input
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <label>
              Giriş e-postası
              <input
                type="email"
                autoComplete="off"
                value={email}
                maxLength={254}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label>
              Başlangıç şablonu
              <select
                value={template}
                onChange={(e) => {
                  const id = e.target.value as OnboardingTemplateId;
                  setTemplate(id);
                  setGrants([...createOnboardingTemplateGrants(id)]);
                }}
              >
                <option value="personel">Personel</option>
                <option value="yetkili_personel">Yetkili Personel</option>
              </select>
            </label>
            <PermissionEditor grants={grants} onChange={setGrants} />
            <p>İlk girişte zorunlu şifre değişimi yapılmadan CRM verisi açılmaz.</p>
            <div className="auth-actions">
              <button disabled={busy}>Onayla ve oluştur</button>
              <button type="button" onClick={() => setCreate(false)}>
                Vazgeç
              </button>
            </div>
          </form>
        </section>
      )}
      {selected && (
        <section className="auth-card personnel-form">
          <h2>Personel işlem onayı</h2>
          <p>
            {selected.person.display_name} · {selected.person.login_email}
          </p>
          <p>
            Bu işlem mevcut erişim ve oturumları değiştirebilir. Şifre sıfırlama izinleri veya pasif
            üyeliği yeniden etkinleştirmez. Yeniden etkinleştirmede yeni geçici şifre zorunludur.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const command: Record<string, unknown> = {
                kind: selected.kind,
                targetId: selected.person.id,
                expectedVersion: selected.person.version,
                reason,
              };
              if (['permissions', 'promote', 'demote'].includes(selected.kind))
                command.grants = grants;
              if (selected.kind === 'transfer') {
                command.oldOwnerGrants = [...createOnboardingTemplateGrants('personel')];
                command.newOwnerGrants = selected.person.grants.filter(
                  (g) =>
                    PERMISSION_CATALOG.find((p) => p.code === g.permission_code)?.classification ===
                    'SENSITIVE',
                );
              }
              void execute(command);
            }}
          >
            <label>
              Gerekçe
              <textarea
                value={reason}
                minLength={3}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                required
              />
            </label>
            {selected.kind === 'permissions' && selected.person.type === 'MEMBER' && (
              <div>
                <p>
                  Mevcut izinler otomatik değiştirilmez. Aşağıdaki işlem ortak
                  müşteri/poliçe/yenileme izinlerini taslağa ekler; kişisel kısıtları inceleyip
                  gerekçeli güvenli onay vermeden kaydedilmez. Hassas veri izinleri eklenmez.
                  Çalışanlar eski AGENCY görev izni bulunsa da yalnız kendi görevlerini görür; atama
                  ve yönetim raporları OWNER'a ayrılmıştır.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    setGrants((current) => {
                      const merged = new Map(
                        current.map((grant) => [grant.permission_code, grant]),
                      );
                      for (const grant of createOnboardingTemplateGrants('personel'))
                        merged.set(grant.permission_code, grant);
                      return [...merged.values()];
                    })
                  }
                >
                  Standart ortak çalışma izinlerini taslağa uygula
                </button>
              </div>
            )}
            {['permissions', 'promote', 'demote'].includes(selected.kind) && (
              <PermissionEditor
                grants={grants}
                onChange={setGrants}
                owner={
                  selected.kind === 'promote' ||
                  (selected.kind === 'permissions' && selected.person.type === 'OWNER')
                }
              />
            )}
            <div className="auth-actions">
              <button disabled={busy}>İşlemi onayla</button>
              <button type="button" onClick={() => setSelected(null)}>
                Vazgeç
              </button>
            </div>
          </form>
        </section>
      )}
      {reauth && (
        <ReauthForm
          onCancel={() => {
            setReauth(false);
            setPending(null);
          }}
          onSuccess={() => {
            setReauth(false);
            const command = pending;
            setPending(null);
            if (command) void execute(command);
          }}
        />
      )}
      {temporary !== null && (
        <div className="auth-backdrop">
          <section
            className="auth-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="temporary-title"
          >
            <h2 id="temporary-title">Geçici şifre — yalnız bir kez</h2>
            <p>
              Bu şifre tekrar görüntülenemez. 24 saat geçerlidir; ilk girişte çalışan yeni şifresini
              belirler. Kalıcı şifreyi yalnız çalışan bilir.
            </p>
            <output className="temporary-secret">{temporary}</output>
            <div className="auth-actions">
              <button onClick={() => void navigator.clipboard.writeText(temporary)}>Kopyala</button>
              <button onClick={() => setTemporary(null)}>Güvenli biçimde kapat</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

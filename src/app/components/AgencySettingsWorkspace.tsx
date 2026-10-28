import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Building2, CalendarClock, Globe2, LockKeyhole, Save, Check } from 'lucide-react';
import type { AgencySettingsDto, InsurerDto } from '../../shared/types';
import { getCsrfToken, invalidateCsrfToken } from '../App';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NavigationDecision } from './layout/NavigationDecision';
import { useSettingsNavigation } from './settings-navigation';
import './settings-v4.css';

type Draft = { defaultInsurerId: string; timezone: string; days: string };
type Attempt = { body: string; key: string };
const draftOf = (s: AgencySettingsDto): Draft => ({
  defaultInsurerId: s.defaultInsurerId ?? '',
  timezone: s.timezone,
  days: String(s.renewalWindowDays),
});
class ReadError extends Error {
  constructor(readonly status: number) {
    super('read');
  }
}
async function read<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new ReadError(r.status);
  const j = (await r.json()) as { success: boolean; data: T };
  if (!j.success || !j.data) throw new ReadError(503);
  return j.data;
}
function message(status: number) {
  if (status === 401) return 'Oturumunuz sona erdi. Yeniden giriş yapın.';
  if (status === 403)
    return 'Ayarları düzenleme yetkiniz artık yok. Taslağınız bu ekranda korunuyor.';
  if (status === 409)
    return 'Ayarlar başka bir işlemle değişti. Taslağınız korunuyor; güncel değerleri karşılaştırın.';
  if (status === 400 || status === 422)
    return 'Bilgileri kontrol edin. Gün aralığı, saat dilimi ve seçilen şirket geçerli olmalıdır.';
  return 'Sonuç kesinleşmedi. Aynı isteği yeniden deneyin; yeni bir kayıt göndermeyin.';
}
export function AgencySettingsPanel() {
  const id = useId();
  const mounted = useRef(false),
    busyRef = useRef(false),
    generation = useRef(0),
    capabilityGeneration = useRef(0);
  const [settings, setSettings] = useState<AgencySettingsDto | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [insurers, setInsurers] = useState<InsurerDto[] | null>(null);
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState('');
  const [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  const [invalid, setInvalid] = useState<'days' | 'timezone' | null>(null);
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Attempt | null>(null);
  const [conflict, setConflict] = useState(false),
    [comparison, setComparison] = useState<AgencySettingsDto | null>(null);
  const [readback, setReadback] = useState(false);
  const hold = busy || pending !== null || readback;
  const dirty =
    !!settings && !!draft && JSON.stringify(draft) !== JSON.stringify(draftOf(settings));
  const nav = useSettingsNavigation(dirty, hold, () =>
    setError('İşlem sonucu çözülmeden ayrılamazsınız. Önce sonucu doğrulayın.'),
  );
  const apply = useCallback((s: AgencySettingsDto) => {
    setSettings(s);
    setDraft(draftOf(s));
  }, []);
  const capability = useCallback(async () => {
    const request = ++capabilityGeneration.current;
    try {
      const c = await read<{ canManage: boolean }>('/api/agency/settings/capabilities');
      if (mounted.current && request === capabilityGeneration.current)
        setCanManage(c.canManage === true);
      return c;
    } catch (e) {
      if (mounted.current && request === capabilityGeneration.current) setCanManage(null);
      throw e;
    }
  }, []);
  const load = useCallback(async () => {
    const g = ++generation.current;
    setLoading(true);
    setLoadError('');
    try {
      const [s, , i] = await Promise.all([
        read<AgencySettingsDto>('/api/agency/settings'),
        capability(),
        read<InsurerDto[]>('/api/catalogs/insurers?includeInactive=true'),
      ]);
      if (!mounted.current || g !== generation.current) return;
      apply(s);
      setInsurers(i);
    } catch (e) {
      if (!mounted.current || g !== generation.current) return;
      setCanManage(null);
      setLoadError(
        e instanceof ReadError && e.status === 401
          ? message(401)
          : 'Ayarlar veya yetki bilgisi yüklenemedi. Yeniden deneyin.',
      );
    } finally {
      if (mounted.current && g === generation.current) setLoading(false);
    }
  }, [apply, capability]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
      capabilityGeneration.current++;
    };
  }, [load]);
  // Recheck edit capability on return to this window; never overwrite an unsaved draft.
  useEffect(() => {
    const refresh = async () => {
      try {
        await capability();
      } catch {
        // The latest capability request already failed closed; keep the draft.
      }
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [capability]);
  async function verifySaved() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const g = generation.current;
    try {
      const s = await read<AgencySettingsDto>('/api/agency/settings');
      if (!mounted.current || g !== generation.current) return;
      apply(s);
      setReadback(false);
      setSuccess('Ayarlar kaydedildi. Güncel değerler doğrulandı.');
    } catch (e) {
      if (mounted.current && g === generation.current)
        setError(
          e instanceof ReadError && e.status === 401
            ? message(401)
            : 'Kayıt onaylandı, güncel değerler okunamadı. Yalnız sonucu yeniden kontrol edin.',
        );
    } finally {
      busyRef.current = false;
      if (mounted.current && g === generation.current) setBusy(false);
    }
  }
  async function execute(attempt: Attempt) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setSuccess('');
    const g = generation.current;
    const live = () => mounted.current && g === generation.current;
    let accepted = false;
    try {
      // Fresh action decision immediately before every write or exact retry.
      const c = await capability();
      if (!live()) return;
      if (c.canManage !== true) {
        setError(message(403));
        return;
      }
      const token = await getCsrfToken();
      if (!live()) return;
      const r = await fetch('/api/agency/settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token,
          'Idempotency-Key': attempt.key,
        },
        body: attempt.body,
      });
      if (!live()) return;
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: { code?: string } } | null;
        if (!live()) return;
        const csrf = r.status === 403 && j?.error?.code?.startsWith('CSRF');
        if (csrf) {
          invalidateCsrfToken();
          setPending(attempt);
          setError('Güvenlik doğrulaması yenilenmeli. Aynı isteği yeniden deneyin.');
        } else {
          setError(message(r.status));
          if (r.status >= 500 || r.status === 429) setPending(attempt);
          else {
            setPending(null);
            if (r.status === 409) {
              setConflict(true);
              setComparison(null);
            }
            if (r.status === 401 || r.status === 403) setCanManage(false);
          }
        }
        return;
      }
      // PATCH acceptance is not readback: do not resend if the following GET fails.
      accepted = true;
      setPending(null);
      setReadback(true);
      setConflict(false);
      setComparison(null);
      const s = await read<AgencySettingsDto>('/api/agency/settings');
      if (!live()) return;
      apply(s);
      setReadback(false);
      setSuccess('Ayarlar kaydedildi. Güncel değerler doğrulandı.');
    } catch (e) {
      if (!live()) return;
      if (accepted) {
        setPending(null);
        setReadback(true);
        setError(
          e instanceof ReadError && e.status === 401
            ? message(401)
            : 'Kayıt onaylandı, güncel değerler okunamadı. Yalnız sonucu yeniden kontrol edin.',
        );
      } else if (e instanceof ReadError) {
        setCanManage(null);
        setError(
          e.status === 401
            ? message(401)
            : 'Yetki veya güncel kayıt doğrulanamadı. Sonucu kontrol edin.',
        );
      } else {
        setPending(attempt);
        setError(message(503));
      }
    } finally {
      busyRef.current = false;
      if (live()) setBusy(false);
    }
  }
  async function compare() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const g = generation.current;
    try {
      const [s] = await Promise.all([
        read<AgencySettingsDto>('/api/agency/settings'),
        capability(),
      ]);
      if (!mounted.current || g !== generation.current) return;
      setComparison(s);
    } catch {
      if (mounted.current && g === generation.current)
        setError('Güncel değerler yüklenemedi. Taslağınız korunuyor.');
    } finally {
      busyRef.current = false;
      if (mounted.current && g === generation.current) setBusy(false);
    }
  }
  function save(e: FormEvent) {
    e.preventDefault();
    if (!draft || !settings || !canManage || hold || conflict || !dirty) return;
    setError('');
    setInvalid(null);
    if (!/^\d+$/.test(draft.days) || Number(draft.days) < 1 || Number(draft.days) > 120) {
      setInvalid('days');
      setError('Yenileme takibi en az 1, en fazla 120 tam gün olabilir.');
      document.getElementById(id + '-days')?.focus();
      return;
    }
    try {
      if (!draft.timezone.trim() || draft.timezone.trim().length > 50) throw new Error();
      new Intl.DateTimeFormat('tr', { timeZone: draft.timezone.trim() });
    } catch {
      setInvalid('timezone');
      setError('Geçerli bir IANA saat dilimi girin. Örneğin Europe/Istanbul.');
      document.getElementById(id + '-timezone')?.focus();
      return;
    }
    const body: Record<string, unknown> = { expectedVersion: settings.version };
    if (draft.defaultInsurerId !== (settings.defaultInsurerId ?? ''))
      body.defaultInsurerId = draft.defaultInsurerId || null;
    if (draft.timezone.trim() !== settings.timezone) body.timezone = draft.timezone.trim();
    if (Number(draft.days) !== settings.renewalWindowDays)
      body.renewalWindowDays = Number(draft.days);
    if (Object.keys(body).length === 1) {
      setDraft(draftOf(settings));
      return;
    }
    void execute({ body: JSON.stringify(body), key: crypto.randomUUID() });
  }
  const insurerName = (s: AgencySettingsDto) =>
    !s.defaultInsurerId
      ? 'Varsayılan şirket yok'
      : (insurers?.find((i) => i.id === s.defaultInsurerId)?.name ?? 'Şirket bilgisi mevcut değil');
  const edit = canManage === true && !!draft;
  function field(key: keyof Draft, value: string) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setSuccess('');
    setInvalid(null);
  }
  function rebase() {
    if (!comparison || !settings || !draft) return;
    const old = draftOf(settings),
      current = draftOf(comparison);
    setDraft({
      defaultInsurerId:
        draft.defaultInsurerId !== old.defaultInsurerId
          ? draft.defaultInsurerId
          : current.defaultInsurerId,
      timezone: draft.timezone !== old.timezone ? draft.timezone : current.timezone,
      days: draft.days !== old.days ? draft.days : current.days,
    });
    setSettings(comparison);
    setComparison(null);
    setConflict(false);
    setError('');
  }
  return (
    <section className="settings-v4" aria-busy={loading}>
      <header className="settings-heading">
        <div>
          <span className="settings-eyebrow">YÖNETİM / ACENTE</span>
          <h1>Acente Ayarları</h1>
          <p>Günlük çalışmanızın ortak tercihleri.</p>
        </div>
        <span className="settings-access">
          <LockKeyhole size={15} />
          {canManage === true
            ? 'Düzenleme yetkisi'
            : canManage === false
              ? 'Salt okunur'
              : 'Yetki doğrulanıyor'}
        </span>
      </header>
      {loading ? (
        <p role="status">Acente ayarları yükleniyor…</p>
      ) : loadError ? (
        <div role="alert" className="settings-notice">
          <p>{loadError}</p>
          <Button variant="outline" onClick={() => void load()}>
            Yeniden yükle
          </Button>
        </div>
      ) : (
        settings &&
        draft && (
          <>
            {canManage !== true && (
              <div className="settings-notice">
                <LockKeyhole size={18} />
                <div>
                  <strong>
                    {canManage === false
                      ? 'Bu ayarlar görüntüleme modunda'
                      : 'Düzenleme yetkisi doğrulanamadı'}
                  </strong>
                  <p>
                    Acente ayarlarını okuyabilirsiniz. Değişiklik için acente sahibinden düzenleme
                    yetkisi isteyin.
                  </p>
                </div>
              </div>
            )}
            {error && (
              <div role="alert" id={id + '-error'} className="settings-notice settings-error">
                <div>
                  <strong>İşlemi kontrol edin</strong>
                  <p>{error}</p>
                </div>
              </div>
            )}
            {success && (
              <div role="status" className="settings-notice settings-success">
                <Check size={18} />
                {success}
              </div>
            )}
            <form noValidate onSubmit={save}>
              <div className="settings-surface">
                <div className="settings-section">
                  <div className="settings-section-title">
                    <Building2 />
                    <div>
                      <h2>Poliçe başlangıcı</h2>
                      <p>Yeni kayıtlarda bir adım daha az.</p>
                    </div>
                  </div>
                  <div className="settings-field">
                    <label htmlFor={id + '-insurer'}>Varsayılan sigorta şirketi</label>
                    {edit ? (
                      <select
                        id={id + '-insurer'}
                        value={draft.defaultInsurerId}
                        disabled={hold}
                        onChange={(e) => field('defaultInsurerId', e.target.value)}
                      >
                        <option value="">Varsayılan şirket yok</option>
                        {insurers
                          ?.filter((i) => i.status === 'ACTIVE' || i.id === draft.defaultInsurerId)
                          .map((i) => (
                            <option key={i.id} value={i.id} disabled={i.status !== 'ACTIVE'}>
                              {i.name}
                              {i.status !== 'ACTIVE' ? ' · Pasif' : ''}
                            </option>
                          ))}
                      </select>
                    ) : (
                      <div className="settings-value">{insurerName(settings)}</div>
                    )}
                    <p>Yeni poliçelerde önerilir; mevcut poliçeler ve geçmiş kayıtlar değişmez.</p>
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-title">
                    <CalendarClock />
                    <div>
                      <h2>Yenileme takibi</h2>
                      <p>Vadeler yaklaşırken hazırlıklı olun.</p>
                    </div>
                  </div>
                  <div className="settings-field">
                    <label htmlFor={id + '-days'}>Takibe başlama süresi</label>
                    {edit ? (
                      <div className="settings-days">
                        <Input
                          id={id + '-days'}
                          type="number"
                          min={1}
                          max={120}
                          step={1}
                          required
                          value={draft.days}
                          disabled={hold}
                          aria-invalid={invalid === 'days'}
                          aria-describedby={invalid === 'days' ? id + '-error' : id + '-days-help'}
                          onChange={(e) => field('days', e.target.value)}
                        />
                        <span>gün önce</span>
                      </div>
                    ) : (
                      <div className="settings-value">
                        Vadeden {settings.renewalWindowDays} gün önce
                      </div>
                    )}
                    <p id={id + '-days-help'}>
                      1–120 gün. Uygun poliçeler için yenileme takibinin başlayacağı pencere;
                      müşteriye otomatik mesaj göndermez.
                    </p>
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-title">
                    <Globe2 />
                    <div>
                      <h2>Çalışma takvimi</h2>
                      <p>Günlük işlerin ortak saat dilimi.</p>
                    </div>
                  </div>
                  <div className="settings-field">
                    <label htmlFor={id + '-timezone'}>Saat dilimi</label>
                    {edit ? (
                      <>
                        <Input
                          id={id + '-timezone'}
                          list={id + '-timezones'}
                          required
                          maxLength={50}
                          value={draft.timezone}
                          disabled={hold}
                          aria-invalid={invalid === 'timezone'}
                          aria-describedby={
                            invalid === 'timezone' ? id + '-error' : id + '-timezone-help'
                          }
                          onChange={(e) => field('timezone', e.target.value)}
                        />
                        <datalist id={id + '-timezones'}>
                          <option value="Europe/Istanbul">Türkiye</option>
                          <option value="Europe/London">Londra</option>
                          <option value="Europe/Berlin">Berlin</option>
                          <option value="UTC">UTC</option>
                        </datalist>
                      </>
                    ) : (
                      <div className="settings-value">
                        {settings.timezone === 'Europe/Istanbul'
                          ? 'Türkiye · Europe/Istanbul'
                          : settings.timezone}
                      </div>
                    )}
                    <p id={id + '-timezone-help'}>
                      Türkiye için Europe/Istanbul. Günlük hesaplamalarda kullanılır; kayıt
                      zamanları UTC olarak saklanır.
                    </p>
                  </div>
                </div>
              </div>
              {dirty && !edit && (
                <div className="settings-notice">
                  <p>
                    Kaydedilmemiş taslağınız korunuyor. Yetki yeniden doğrulanana kadar kayıt
                    gönderilmez.
                  </p>
                  <dl className="settings-draft">
                    <dt>Şirket</dt>
                    <dd>
                      {draft.defaultInsurerId
                        ? (insurers?.find((i) => i.id === draft.defaultInsurerId)?.name ??
                          'Şirket bilgisi mevcut değil')
                        : 'Varsayılan şirket yok'}
                    </dd>
                    <dt>Takip süresi</dt>
                    <dd>{draft.days} gün</dd>
                    <dt>Saat dilimi</dt>
                    <dd>{draft.timezone}</dd>
                  </dl>
                </div>
              )}
              {conflict && (
                <section className="settings-compare">
                  <h2>Değişiklikleri karşılaştırın</h2>
                  <p>Güncel değerleri okumak taslağınızı değiştirmez.</p>
                  <Button variant="outline" disabled={busy} onClick={() => void compare()}>
                    Güncel değerleri karşılaştır
                  </Button>
                  {comparison && (
                    <>
                      <dl>
                        <dt>Güncel şirket</dt>
                        <dd>{insurerName(comparison)}</dd>
                        <dt>Güncel takip süresi</dt>
                        <dd>{comparison.renewalWindowDays} gün</dd>
                        <dt>Güncel saat dilimi</dt>
                        <dd>{comparison.timezone}</dd>
                      </dl>
                      <Button disabled={!canManage || busy} onClick={rebase}>
                        Taslağımı güncel kayıt üzerine hazırla
                      </Button>
                      <p>Yalnız değiştirdiğiniz alanlar, yeniden Kaydet dediğinizde gönderilir.</p>
                    </>
                  )}
                </section>
              )}
              <footer className="settings-savebar">
                <span>
                  {hold
                    ? readback
                      ? 'Kayıt alındı · Sonuç doğrulanıyor'
                      : 'İşlem sonucu bekleniyor'
                    : dirty
                      ? 'Kaydedilmemiş değişiklikler'
                      : 'Güncel ayarlar'}
                </span>
                <div>
                  {!hold && dirty && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        nav.guard(() => {
                          apply(settings);
                          setError('');
                          setConflict(false);
                          setComparison(null);
                        })
                      }
                    >
                      Değişiklikleri geri al
                    </Button>
                  )}
                  {readback ? (
                    <Button disabled={busy} onClick={() => void verifySaved()}>
                      Kaydı yeniden kontrol et
                    </Button>
                  ) : pending ? (
                    <Button disabled={busy} onClick={() => void execute(pending)}>
                      Aynı isteği yeniden dene
                    </Button>
                  ) : (
                    edit && (
                      <Button type="submit" disabled={!dirty || busy || conflict}>
                        <Save size={16} />
                        {busy ? 'Kaydediliyor…' : 'Ayarları kaydet'}
                      </Button>
                    )
                  )}
                </div>
              </footer>
            </form>
            <p className="settings-footnote">
              <LockKeyhole size={14} />
              Bu sayfa yalnız operasyon tercihlerini yönetir. Personel ve kritik güvenlik işlemleri
              kendi korumalı akışlarında kalır.
            </p>
          </>
        )
      )}
      {nav.leave && (
        <NavigationDecision onStay={nav.stay}>
          <h2 id="navigation-decision-title">Kaydedilmemiş değişiklikler var</h2>
          <p>Ayrılırsanız bu ekrandaki taslak bırakılacak.</p>
          <Button variant="outline" onClick={nav.stay}>
            Bu ekranda kal
          </Button>
          <Button
            onClick={() => {
              const go = nav.leave;
              nav.stay();
              go?.();
            }}
          >
            Ayrılmayı onayla
          </Button>
        </NavigationDecision>
      )}
    </section>
  );
}

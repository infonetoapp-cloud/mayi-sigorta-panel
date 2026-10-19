import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiResponse, LossReasonDto, TodayTaskDto } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { parseAppError } from '../../App';
import { CustomerReadError, readCustomerResource } from '../customers/customer-resource';
import type { TaskOperationRisk, TaskReadback } from './TaskOperationsSection';

interface Props {
  task: TodayTaskDto;
  read: (signal: AbortSignal) => Promise<TaskReadback>;
  canOperate: () => boolean;
  onRisk: (risk: TaskOperationRisk) => void;
  onApplied: (message: string) => void;
}
type Kind = 'LOST' | 'VOIDED';
const voidReasons = {
  TECHNICAL_ERROR: 'Teknik hata — yanlış veya hatalı oluşturulmuş yenileme kaydı.',
  DUPLICATE: 'Mükerrer kayıt — aynı yenileme işi zaten başka bir kayıtta izleniyor.',
  NOT_ELIGIBLE_AFTER_CANCELLATION_OR_RESTRUCTURE:
    'İptal veya yeniden yapılandırma sonrası bu kayıt üzerinden yenileme artık uygun değil.',
} as const;
interface Attempt {
  readonly kind: Kind;
  readonly url: string;
  readonly method: 'POST';
  readonly body: string;
  readonly key: string;
  readonly target: TodayTaskDto;
}
interface Result {
  renewalId: string;
  primaryTaskId: string;
  previousState: string;
  state: Kind;
  renewalVersion: number;
  taskVersion: number;
  closedAt: string;
  lossReasonId?: string;
  voidReasonCode?: string;
}
interface Accepted {
  attempt: Attempt;
  result: Result | null;
}
function canonicalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) && d.toISOString() === value;
}
function validResult(value: unknown, a: Attempt): value is Result {
  if (!value || typeof value !== 'object') return false;
  const r = value as Result,
    b = JSON.parse(a.body);
  return (
    r.renewalId === a.target.renewalId &&
    r.primaryTaskId === a.target.taskId &&
    r.primaryTaskId === b.expectedPrimaryTaskId &&
    r.previousState === a.target.renewalState &&
    r.state === a.kind &&
    r.renewalVersion === a.target.renewalVersion + 1 &&
    r.taskVersion === a.target.taskVersion + 1 &&
    canonicalDate(r.closedAt) &&
    (a.kind === 'LOST'
      ? r.lossReasonId === b.lossReasonId && r.voidReasonCode === undefined
      : r.voidReasonCode === b.voidReasonCode && r.lossReasonId === undefined)
  );
}
const openState = (t: TodayTaskDto) => !['WON', 'LOST', 'VOIDED'].includes(t.renewalState);
const sameTarget = (a: TodayTaskDto, b: TodayTaskDto) =>
  a.taskId === b.taskId && a.renewalId === b.renewalId && a.customerId === b.customerId;
async function catalog(signal: AbortSignal) {
  const d = await readCustomerResource<{ lossReasons: LossReasonDto[] }>(
    '/api/catalogs/selectable',
    signal,
  );
  if (
    !Array.isArray(d.lossReasons) ||
    d.lossReasons.some(
      (r) =>
        !r.id ||
        !r.code ||
        typeof r.name !== 'string' ||
        r.status !== 'ACTIVE' ||
        !Number.isSafeInteger(r.version),
    )
  )
    throw new Error('INVALID_CATALOG');
  return d.lossReasons;
}
async function renewalReadback(a: Attempt, signal: AbortSignal) {
  // Real contract: raw last-renewal ID cursor, not queue cursor or fabricated task detail.
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const root = `/api/customers/${encodeURIComponent(a.target.customerId)}/renewals?limit=50`;
    const d: {
      items: { id: string; state: string; version: number }[];
      nextCursor: string | null;
    } = await readCustomerResource(
      root + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      signal,
    );
    if (!Array.isArray(d.items) || !(d.nextCursor === null || typeof d.nextCursor === 'string'))
      throw new Error('INVALID_READBACK');
    const matches = d.items.filter((r) => r.id === a.target.renewalId);
    if (matches.length > 1) throw new Error('INVALID_READBACK');
    if (matches.length === 1) return matches[0]!;
    if (!d.nextCursor) break;
    if (
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(d.nextCursor) ||
      seen.has(d.nextCursor) ||
      d.items.at(-1)?.id !== d.nextCursor
    )
      throw new Error('INVALID_CURSOR');
    seen.add(d.nextCursor);
    cursor = d.nextCursor;
  }
  throw new Error('READBACK_NOT_FOUND_WITHIN_BOUND');
}
function useOutcome(kind: Kind, props: Props, blocked: () => boolean) {
  const [target, setTarget] = useState<TodayTaskDto | null>(null),
    [reason, setReason] = useState(''),
    [notes, setNotes] = useState(''),
    [reasons, setReasons] = useState<LossReasonDto[] | null>(null),
    [chosen, setChosen] = useState<LossReasonDto | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Attempt | null>(null),
    [accepted, setAccepted] = useState<Accepted | null>(null),
    [needsCompare, setNeedsCompare] = useState(false),
    [comparison, setComparison] = useState<TodayTaskDto | null>(null),
    [masked, setMasked] = useState(false),
    [error, setError] = useState('');
  const lock = useRef(false),
    epoch = useRef(0),
    controllers = useRef(new Set<AbortController>()),
    heading = useRef<HTMLHeadingElement>(null);
  const alive = (e: number, c: AbortController) => e === epoch.current && !c.signal.aborted;
  useEffect(
    () => () => {
      epoch.current++;
      for (const c of controllers.current) c.abort();
    },
    [],
  );
  useEffect(() => {
    if (target) heading.current?.focus();
  }, [target]);
  async function refreshCatalog() {
    if (lock.current || pending || accepted) return;
    const e = epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    lock.current = true;
    setBusy(true);
    setConfirmed(false);
    try {
      const rows = await catalog(c.signal);
      if (!alive(e, c)) return;
      setReasons(rows);
      setError('');
    } catch {
      if (alive(e, c)) {
        setReasons(null);
        setError(
          'Kayıp nedenleri yetkili olarak okunamadı. Taslak korunur; yeni gönderim kapalıdır.',
        );
      }
    } finally {
      controllers.current.delete(c);
      lock.current = false;
      if (e === epoch.current) setBusy(false);
    }
  }
  function open() {
    if (lock.current || pending || accepted || blocked() || !props.canOperate()) return;
    setTarget({ ...props.task });
    setReason('');
    setNotes('');
    setChosen(null);
    setConfirmed(false);
    setNeedsCompare(false);
    setComparison(null);
    setMasked(false);
    setError('');
    if (kind === 'LOST') void refreshCatalog();
  }
  async function verify(saved: Accepted, e: number, c: AbortController) {
    try {
      const row = await renewalReadback(saved.attempt, c.signal);
      if (!alive(e, c)) return;
      const r = saved.result;
      if (!r || row.state !== r.state || row.version !== r.renewalVersion) {
        setError(
          `POST kabul edildi ancak kanıt eksik veya güncel yenileme durumu/sürümü çelişkili. Başarı doğrulanmadı; yalnız GET ile tekrar kontrol edin. Yeniden POST yapılmaz.`,
        );
        return;
      }
      setAccepted(null);
      setTarget(null);
      setConfirmed(false);
      setReason('');
      setNotes('');
      props.onApplied(
        `${kind} sonucu: POST yanıtı ve yetkili yenileme state/sürüm okuması doğrulandı. Sunucu yanıtı birincil görevin atomik kapanışını bildirir; bu GET tamamlanan görev ayrıntısı sağlamaz. İş listesi ve istatistikler yenileniyor.`,
      );
    } catch (cause) {
      if (!alive(e, c)) return;
      if (cause instanceof CustomerReadError && [401, 403, 404].includes(cause.status))
        setMasked(true);
      setError(
        'POST kabul edildi; bağımsız yetkili yenileme okuması doğrulanamadı (izin, bağlantı veya sınırlı sayfalama). Başarı doğrulanmadı. Yalnız GET okumasını yeniden deneyin; POST tekrarlanmaz.',
      );
    }
  }
  async function recover() {
    if (!accepted || lock.current) return;
    const e = epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    lock.current = true;
    setBusy(true);
    try {
      await verify(accepted, e, c);
    } finally {
      controllers.current.delete(c);
      lock.current = false;
      if (e === epoch.current) setBusy(false);
    }
  }
  async function transmit(a: Attempt) {
    if (lock.current || accepted || blocked() || !props.canOperate()) return;
    lock.current = true;
    setBusy(true);
    setPending(a);
    setError('');
    const e = epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    try {
      const csrf = await getCsrfToken();
      if (!alive(e, c)) return;
      const response = await fetch(a.url, {
        method: a.method,
        body: a.body,
        signal: c.signal,
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          'idempotency-key': a.key,
        },
      });
      if (!alive(e, c)) return;
      const body = (await response.json().catch(() => null)) as ApiResponse<unknown> | null;
      if (!alive(e, c)) return;
      if (!response.ok) {
        if (response.status >= 500 || [408, 429].includes(response.status))
          throw new Error('UNCERTAIN');
        if (response.status === 403) invalidateCsrfToken();
        setPending(null);
        setConfirmed(false);
        setNeedsCompare(true);
        setComparison(null);
        if ([401, 403, 404].includes(response.status)) setMasked(true);
        setError(
          response.status === 409
            ? 'Sonuçlandırma çakıştı. Eski seçim ve taslak korunur; özgün görev sayfasını yetkili okuyup sürümleri karşılaştırın. Otomatik yeni istek yok.'
            : parseAppError(response.status, body && !body.success ? body.error : undefined)
                .message,
        );
        return;
      }
      // Any accepted HTTP write is GET-only thereafter, even with malformed success evidence.
      const saved: Accepted = {
        attempt: a,
        result: body?.success && validResult(body.data, a) ? body.data : null,
      };
      setPending(null);
      setAccepted(saved);
      await verify(saved, e, c);
    } catch {
      if (alive(e, c))
        setError(
          'Sonuç belirsiz. Özgün hedef, çift sürüm, URL, body ve anahtar korunur. Yalnız aynı isteği yeniden deneyin; ayrılmak sunucudaki işlemi iptal etmez.',
        );
    } finally {
      controllers.current.delete(c);
      lock.current = false;
      if (e === epoch.current) setBusy(false);
    }
  }
  async function compare() {
    if (!target || lock.current || pending || accepted || blocked() || !props.canOperate()) return;
    const e = epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    lock.current = true;
    setBusy(true);
    setConfirmed(false);
    setComparison(null);
    try {
      const fresh = await props.read(c.signal),
        rows = kind === 'LOST' ? await catalog(c.signal) : null;
      if (!alive(e, c)) return;
      const t = fresh.current;
      setReasons(rows);
      setMasked(false);
      if (!t || !sameTarget(t, target) || !openState(t)) {
        setError(
          'Özgün görev artık yetkili sayfada uygun değil. Başka birincil göreve geçilmedi; yeni yazım kapalı.',
        );
        return;
      }
      setComparison(t);
      setError(
        'Önceki ve güncel sürümleri karşılaştırın; güncel aynı hedefi açıkça benimseyip son onayı yeniden verin.',
      );
    } catch {
      if (alive(e, c)) {
        setMasked(true);
        setError('Güncel yetkili karşılaştırma okunamadı. Taslak ve eski hedef korunur.');
      }
    } finally {
      controllers.current.delete(c);
      lock.current = false;
      if (e === epoch.current) setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !target ||
      lock.current ||
      pending ||
      accepted ||
      needsCompare ||
      masked ||
      blocked() ||
      !props.canOperate() ||
      !openState(target)
    )
      return;
    if (!confirmed || !reason) {
      setError('Açık neden seçimi ve ayrı son onay gerekir.');
      return;
    }
    const trimmed = notes.trim();
    if (
      kind === 'LOST' &&
      (!chosen ||
        !reasons?.some(
          (r) => r.id === reason && r.code === chosen.code && r.version === chosen.version,
        ) ||
        (chosen.code === 'OTHER' && (!trimmed || trimmed.length > 500)))
    ) {
      setError('Aktif kayıp nedeni ve OTHER için 1–500 karakter açıklama gerekir.');
      return;
    }
    if (kind === 'VOIDED' && !Object.hasOwn(voidReasons, reason)) return;
    // Revalidate the selected catalog entry without silently replacing a stale selection.
    if (kind === 'LOST') {
      const e = epoch.current,
        c = new AbortController();
      controllers.current.add(c);
      lock.current = true;
      setBusy(true);
      try {
        const rows = await catalog(c.signal);
        if (!alive(e, c)) return;
        setReasons(rows);
        if (
          !rows.some(
            (r) => r.id === reason && r.code === chosen!.code && r.version === chosen!.version,
          )
        ) {
          setConfirmed(false);
          setError(
            'Seçilen kayıp nedeni değişti veya pasif. Taslak korunur; nedeni açıkça yeniden seçip onaylayın.',
          );
          return;
        }
      } catch {
        if (alive(e, c)) {
          setReasons(null);
          setError('Kayıp nedenleri okunamadı; taslak korundu, gönderim yapılmadı.');
        }
        return;
      } finally {
        controllers.current.delete(c);
        lock.current = false;
        if (e === epoch.current) setBusy(false);
      }
      if (e !== epoch.current) return;
    }
    const snapshot = { ...target };
    void transmit({
      kind,
      target: snapshot,
      url: `/api/renewals/${encodeURIComponent(snapshot.renewalId)}/${kind === 'LOST' ? 'close-lost' : 'void'}`,
      method: 'POST',
      key: crypto.randomUUID(),
      body: JSON.stringify({
        expectedPrimaryTaskId: snapshot.taskId,
        expectedRenewalVersion: snapshot.renewalVersion,
        expectedTaskVersion: snapshot.taskVersion,
        ...(kind === 'LOST'
          ? { lossReasonId: reason, lossReasonNotes: chosen!.code === 'OTHER' ? trimmed : null }
          : { voidReasonCode: reason }),
      }),
    });
  }
  const unresolved = busy || !!pending || !!accepted,
    risk = { dirty: !!target, unresolved };
  function close() {
    if (unresolved) return;
    setTarget(null);
    setReason('');
    setNotes('');
    setError('');
    setConfirmed(false);
    setComparison(null);
  }
  function panel() {
    return (
      <>
        <Button variant="outline" disabled={!!target || unresolved || blocked()} onClick={open}>
          {kind === 'LOST' ? 'Yenilenmedi olarak sonuçlandır' : 'Geçersiz olarak işaretle'}
        </Button>
        {target && (
          <form
            aria-label={`${kind} sonuçlandırma`}
            onSubmit={(e) => void submit(e)}
            className="today-outcome-form"
          >
            <h4 ref={heading} tabIndex={-1}>
              {kind} sonucu
            </h4>
            <p>
              {kind === 'LOST'
                ? 'Bu sonuç yenilemenin kazanılmadığını kaydeder; mevcut poliçeyi arşivlemez veya geçersiz kılmaz.'
                : 'VOIDED yalnız hatalı veya uygun olmayan yenileme kaydı içindir. Geçerli bir teklifi müşterinin reddetmesi LOST olarak kaydedilir.'}
            </p>
            <p>
              Bu işlem yenilemeyi kapatır ve birincil takibini atomik olarak tamamlar. Yerine yeni
              görev oluşturmaz.
            </p>
            {!masked && (
              <>
                <dl className="today-task-facts">
                  <div>
                    <dt>Müşteri / poliçe</dt>
                    <dd>
                      {target.customerDisplayName} /{' '}
                      {target.policyNumber ?? 'Poliçe özeti mevcut değil'}
                    </dd>
                  </div>
                  <div>
                    <dt>Durum / birincil takip</dt>
                    <dd>
                      {target.renewalState} / {target.title}
                    </dd>
                  </div>
                  <div>
                    <dt>Sabit hedef</dt>
                    <dd>
                      {target.renewalId} / {target.taskId}
                    </dd>
                  </div>
                  <div>
                    <dt>Sürümler</dt>
                    <dd>
                      Yenileme sürümü: {target.renewalVersion} — Görev sürümü: {target.taskVersion}
                    </dd>
                  </div>
                </dl>
                <fieldset disabled={unresolved || needsCompare}>
                  <label>
                    {kind === 'LOST' ? 'Kayıp nedeni' : 'Geçersizlik nedeni'}
                    <select
                      value={reason}
                      onChange={(e) => {
                        setReason(e.target.value);
                        setChosen(reasons?.find((r) => r.id === e.target.value) ?? null);
                        setConfirmed(false);
                      }}
                    >
                      <option value="">Neden seçin</option>
                      {kind === 'LOST'
                        ? reasons?.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))
                        : Object.entries(voidReasons).map(([code, label]) => (
                            <option key={code} value={code}>
                              {label}
                            </option>
                          ))}
                      {kind === 'LOST' && reason && !reasons?.some((r) => r.id === reason) && (
                        <option value={reason} disabled>
                          Önceki seçim artık kullanılamıyor
                        </option>
                      )}
                    </select>
                  </label>
                  {kind === 'LOST' && chosen?.code === 'OTHER' && (
                    <>
                      <label>
                        Diğer kayıp açıklaması
                        <textarea
                          aria-describedby="lost-outcome-note-help"
                          value={notes}
                          maxLength={500}
                          onChange={(e) => {
                            setNotes(e.target.value);
                            setConfirmed(false);
                          }}
                        />
                      </label>
                      <p id="lost-outcome-note-help">
                        Trim sonrası 1–500 karakter. Hassas bilgi yazmayın.
                      </p>
                    </>
                  )}
                  <p>
                    Seçili sonuç: {kind}; neden:{' '}
                    {kind === 'LOST'
                      ? (chosen?.name ?? 'Seçilmedi')
                      : (voidReasons[reason as keyof typeof voidReasons] ?? 'Seçilmedi')}
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    {kind} sonucunu ve seçili nedeni onaylıyorum
                  </label>
                  <Button type="submit" disabled={kind === 'LOST' && !reasons}>
                    {kind} kaydını onayla
                  </Button>
                </fieldset>
              </>
            )}
            {masked && <p>Yetkili bağlam doğrulanamadı; korunan hedef ayrıntıları gizlendi.</p>}
            {error && <p role="alert">{error}</p>}
            {kind === 'LOST' && !pending && !accepted && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void refreshCatalog()}
              >
                Kayıp nedenlerini yeniden oku
              </Button>
            )}
            {needsCompare && !pending && !accepted && (
              <Button type="button" disabled={busy} onClick={() => void compare()}>
                Güncel aynı hedefi karşılaştır
              </Button>
            )}
            {comparison && !masked && (
              <div>
                <p>
                  Önceki yenileme/görev: {target.renewalVersion}/{target.taskVersion}; güncel:{' '}
                  {comparison.renewalVersion}/{comparison.taskVersion}. Aynı görev:{' '}
                  {comparison.taskId}.
                </p>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setTarget({ ...comparison });
                    setComparison(null);
                    setNeedsCompare(false);
                    setConfirmed(false);
                    setError(
                      'Güncel aynı hedef benimsendi. Nedeni kontrol edip son onayı yeniden verin.',
                    );
                  }}
                >
                  Güncel aynı hedefi benimse
                </Button>
              </div>
            )}
            {pending && (
              <Button type="button" disabled={busy} onClick={() => void transmit(pending)}>
                Aynı {kind} isteğini yeniden dene
              </Button>
            )}
            {accepted && (
              <Button type="button" disabled={busy} onClick={() => void recover()}>
                Yalnız yenileme okumasını yeniden dene
              </Button>
            )}
            <Button type="button" variant="outline" disabled={unresolved} onClick={close}>
              Bu sonuç taslağını açıkça kapat
            </Button>
          </form>
        )}
      </>
    );
  }
  return { risk, panel };
}
export function RenewalOutcomesSection(props: Props) {
  const lostRisk = useRef<TaskOperationRisk>({ dirty: false, unresolved: false }),
    voidRisk = useRef<TaskOperationRisk>({ dirty: false, unresolved: false });
  const lost = useOutcome(
      'LOST',
      props,
      () => voidRisk.current.dirty || voidRisk.current.unresolved,
    ),
    voided = useOutcome(
      'VOIDED',
      props,
      () => lostRisk.current.dirty || lostRisk.current.unresolved,
    );
  lostRisk.current = lost.risk;
  voidRisk.current = voided.risk;
  const dirty = lost.risk.dirty || voided.risk.dirty,
    unresolved = lost.risk.unresolved || voided.risk.unresolved;
  useEffect(() => {
    props.onRisk({ dirty, unresolved });
  }, [dirty, unresolved, props.onRisk]);
  return (
    <section aria-label="Yenileme sonuçlandırma" className="today-outcomes">
      <h3>Yenileme sonuçlandırma</h3>
      <p>
        LOST ve VOIDED farklı sonuçlardır. Görünen seçenekler yetki vermez; canlı sunucu izinleri ve
        görev kapsamı her yazımda denetlenir.
      </p>
      {lost.panel()}
      {voided.panel()}
    </section>
  );
}

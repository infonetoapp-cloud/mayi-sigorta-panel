import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ApiResponse, PolicyDetailDto } from '../../../shared/types';
import {
  cancellationReasons,
  policyLifecycleResultSchema,
  type PolicyLifecycleContext,
  type PolicyLifecycleResult,
} from '../../../shared/policy-cancellation';
import { istanbulToday } from '../../../shared/customer-profile';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { CustomerNumberGuard } from '../customers/CustomerNumberGuard';
import { readCustomerResource, useCustomerResource } from '../customers/customer-resource';
import { policyDate } from './policy-display';
import { readPolicyDetail } from './policy-read-schemas';

interface HistoryEntry {
  id: string;
  status: 'CANCELLED' | 'VOIDED';
  eventDate: string;
  reasonCode: string;
  notes: string | null;
}
interface Attempt {
  key: string;
  body: string;
  kind: 'cancel' | 'void';
  result?: PolicyLifecycleResult;
}
const voidReasons = { DUPLICATE: 'Mükerrer kayıt', TECHNICAL_ERROR: 'Hatalı kayıt' };

export function PolicyLifecycleSection({
  policy,
  onUpdated,
}: {
  policy: PolicyDetailDto;
  onUpdated: (p: PolicyDetailDto) => void;
}) {
  const uid = useId(),
    title = useRef<HTMLHeadingElement>(null),
    saving = useRef(false),
    live = useRef(true);
  const base = `/api/policies/${encodeURIComponent(policy.id)}`;
  const history = useCustomerResource<HistoryEntry[]>(
    policy.status === 'ACTIVE' ? null : `${base}/cancellations`,
  );
  const [kind, setKind] = useState<'cancel' | 'void' | null>(null),
    [context, setContext] = useState<PolicyLifecycleContext | null>(null);
  const [date, setDate] = useState(istanbulToday()),
    [reason, setReason] = useState(''),
    [notes, setNotes] = useState('');
  const [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState<Attempt | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (context) title.current?.focus();
  }, [context, review]);
  const locked = busy || !!attempt || blocked;
  const options = kind === 'void' ? voidReasons : cancellationReasons;
  async function start(next: 'cancel' | 'void', keepDraft = false) {
    if (saving.current || attempt) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const current = keepDraft ? await readPolicyDetail(policy.id) : policy;
      const c = await readCustomerResource<PolicyLifecycleContext>(
        `${base}/${next === 'cancel' ? 'cancellation-context' : 'void-context'}`,
      );
      if (!live.current) return;
      if (!c.eligible || c.policyVersion !== current.version)
        throw Error('Poliçe değişmiş veya işleme uygun değil. Sayfayı yenileyin.');
      if (keepDraft) onUpdated(current);
      setContext(c);
      setStale(false);
      setKind(next);
      setReview(false);
      if (!keepDraft) {
        setReason('');
        setNotes('');
        const today = istanbulToday();
        setDate(next === 'cancel' && c.endDate < today ? c.endDate : today);
      }
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : 'İşlem bilgileri yüklenemedi.');
    } finally {
      saving.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function confirm(saved: Attempt) {
    const r = saved.result!;
    const [fresh, events] = await Promise.all([
      readPolicyDetail(policy.id),
      readCustomerResource<HistoryEntry[]>(`${base}/cancellations`),
    ]);
    if (
      fresh.version < r.policyVersion ||
      fresh.status !== r.status ||
      !events.some((h) => h.id === r.eventId && h.status === r.status)
    )
      throw Error('Kayıt henüz doğrulanamadı.');
    if (!live.current) return;
    onUpdated(fresh);
    history.reload();
    setAttempt(null);
    setContext(null);
    setKind(null);
    setReview(false);
    setBlocked(false);
    setMessage(
      r.status === 'CANCELLED' && r.closedRenewalId
        ? 'Poliçe iptal edildi. İlgili açık yenileme takibi kapatıldı.'
        : r.status === 'CANCELLED'
          ? 'Poliçe iptal edildi. Kapatılacak açık yenileme takibi yoktu.'
          : 'Hatalı poliçe kaydı geçersiz kılındı.',
    );
  }
  async function execute(saved: Attempt) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      if (saved.result) {
        await confirm(saved);
        return;
      }
      const token = await getCsrfToken();
      const response = await fetch(`${base}/${saved.kind}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': token,
          'idempotency-key': saved.key,
        },
        body: saved.body,
      });
      if (!live.current) return;
      if (!response.ok) {
        const value = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        if (response.status === 401) {
          invalidateCsrfToken();
          document.dispatchEvent(new Event('mayi-session-ended'));
          setBlocked(true);
        }
        if (response.status === 403) {
          invalidateCsrfToken();
          setBlocked(true);
        }
        if (response.status === 404) setBlocked(true);
        // Only documented rejections prove that this request did not commit.
        if (
          [400, 413, 415].includes(response.status) ||
          (response.status === 409 && value?.error?.code !== 'IDEMPOTENCY_CONFLICT')
        ) {
          setAttempt(null);
          setReview(false);
          if (response.status === 409) {
            setStale(true);
          }
        }
        throw Error(
          value?.error?.message ?? 'İşlem doğrulanamadı. Aynı işlemi tekrar kontrol edin.',
        );
      }
      const value = (await response.json()) as ApiResponse<unknown>;
      if (!value.success) throw Error('İşlem yanıtı doğrulanamadı.');
      const result = policyLifecycleResultSchema.parse(value.data),
        c = JSON.parse(saved.body) as {
          expectedPolicyVersion: number;
          expectedRenewal?: { id: string; primaryTaskId: string };
        };
      if (
        result.policyId !== policy.id ||
        result.policyVersion !== c.expectedPolicyVersion + 1 ||
        result.status !== (saved.kind === 'cancel' ? 'CANCELLED' : 'VOIDED') ||
        result.closedRenewalId !== (c.expectedRenewal?.id ?? null) ||
        result.completedTaskId !== (c.expectedRenewal?.primaryTaskId ?? null)
      )
        throw Error('İşlem yanıtı kayıtla eşleşmedi.');
      const accepted = { ...saved, result };
      setAttempt(accepted);
      await confirm(accepted);
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : 'Kayıt doğrulanamadı.');
    } finally {
      saving.current = false;
      if (live.current) setBusy(false);
    }
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked || stale || !context || !kind) return;
    if (!reason || (reason === 'OTHER' && !notes.trim())) {
      setError('Bir neden seçin; Diğer için açıklama girin.');
      title.current?.focus();
      return;
    }
    const loss = context.lossReasons.find((r) => r.code === reason);
    if (kind === 'cancel' && context.expectedRenewal && !loss) {
      setError(
        'Bu neden için aktif takip gerekçesi bulunamadı. Yönetici katalogdan aynı neden kodunu etkinleştirmeli.',
      );
      title.current?.focus();
      return;
    }
    if (!review) {
      setReview(true);
      setError('');
      return;
    }
    const body = JSON.stringify({
      expectedPolicyVersion: context.policyVersion,
      cancellationDate: date,
      reasonCode: reason,
      reasonNotes: notes.trim() || null,
      targetSetFingerprint: context.targetSetFingerprint,
      ...(context.expectedRenewal
        ? {
            expectedRenewal: context.expectedRenewal,
            ...(kind === 'cancel' ? { lossReasonId: loss!.id } : {}),
          }
        : {}),
    });
    const saved = { body, kind, key: crypto.randomUUID() };
    setAttempt(saved);
    void execute(saved);
  }
  return (
    <Card className="policy-lifecycle">
      <CardHeader>
        <CardTitle>İptal ve kayıt düzeltme</CardTitle>
      </CardHeader>
      <CardContent>
        <CustomerNumberGuard
          dirty={!!context}
          unresolved={!!attempt || busy}
          label="Poliçe işlemi"
        />
        {message && (
          <p role="status" className="policy-lifecycle-success">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="customer-error">
            {error}
          </p>
        )}
        {busy && <p role="status">İşlem kontrol ediliyor…</p>}
        {!context && policy.status === 'ACTIVE' && !policy.archivedAt && (
          <div className="customer-form-actions">
            <Button variant="danger" disabled={locked} onClick={() => void start('cancel')}>
              Poliçeyi iptal et
            </Button>
            <Button variant="outline" disabled={locked} onClick={() => void start('void')}>
              Hatalı kaydı düzelt
            </Button>
          </div>
        )}
        {context && kind && (
          <form
            aria-labelledby={`${uid}-heading`}
            action={`${base}/${kind}`}
            method="post"
            onSubmit={submit}
          >
            <h3 id={`${uid}-heading`} tabIndex={-1} ref={title}>
              {review
                ? 'İşlem özeti'
                : kind === 'cancel'
                  ? 'İptal bilgileri'
                  : 'Hatalı kayıt bilgileri'}
            </h3>
            <p>
              {policy.customer.displayName} · {policy.policyNumber} · {policy.product.name}
            </p>
            {!review ? (
              <fieldset disabled={locked} className="policy-lifecycle-fields">
                <legend>
                  {kind === 'cancel' ? 'İptal nedeni (zorunlu)' : 'Düzeltme nedeni (zorunlu)'}
                </legend>
                <div className="policy-lifecycle-reasons">
                  {Object.entries(options).map(([code, label]) => (
                    <label key={code}>
                      <input
                        type="radio"
                        name="reason"
                        value={code}
                        checked={reason === code}
                        required
                        onChange={() => setReason(code)}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                <label htmlFor={`${uid}-date`}>
                  {kind === 'cancel' ? 'İptal tarihi' : 'İşlem tarihi'} (zorunlu)
                </label>
                <input
                  id={`${uid}-date`}
                  name="date"
                  type="date"
                  required
                  min={kind === 'cancel' ? context.startDate : undefined}
                  max={
                    kind === 'cancel' && context.endDate < istanbulToday()
                      ? context.endDate
                      : istanbulToday()
                  }
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
                <label htmlFor={`${uid}-notes`}>
                  Açıklama {reason === 'OTHER' ? '(zorunlu)' : '(isteğe bağlı)'}
                </label>
                <textarea
                  id={`${uid}-notes`}
                  name="notes"
                  rows={3}
                  maxLength={500}
                  required={reason === 'OTHER'}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </fieldset>
            ) : (
              <div className="policy-lifecycle-summary">
                <dl className="customer-info-grid">
                  <div>
                    <dt>Neden</dt>
                    <dd>{options[reason as keyof typeof options]}</dd>
                  </div>
                  <div>
                    <dt>Tarih</dt>
                    <dd>{policyDate(date)}</dd>
                  </div>
                  {notes && (
                    <div>
                      <dt>Açıklama</dt>
                      <dd>{notes}</dd>
                    </div>
                  )}
                </dl>
                <p>
                  {context.expectedRenewal
                    ? 'Bu poliçenin açık yenilemesi ve ona bağlı takip işi kapanacak.'
                    : 'Kapatılacak açık yenileme takibi yok.'}
                </p>
                <p>
                  Diğer poliçeler, bağımsız işler, hasar ve alacak-tahsilat kayıtları korunur. Bu
                  işlem ödeme veya iade oluşturmaz.
                </p>
              </div>
            )}
            <div className="customer-form-actions">
              {!attempt && (
                <Button
                  type="submit"
                  variant={review ? 'danger' : 'default'}
                  disabled={locked || stale}
                >
                  {review
                    ? kind === 'cancel'
                      ? 'İptali kaydet'
                      : 'Geçersiz kaydı kaydet'
                    : 'Özeti gör'}
                </Button>
              )}
              {review && !attempt && (
                <Button variant="outline" disabled={locked} onClick={() => setReview(false)}>
                  Bilgileri düzenle
                </Button>
              )}
              {!attempt && (
                <Button
                  variant="ghost"
                  disabled={locked}
                  onClick={() => {
                    setContext(null);
                    setKind(null);
                    setError('');
                    setStale(false);
                  }}
                >
                  Vazgeç
                </Button>
              )}
              {stale && (
                <Button variant="outline" disabled={locked} onClick={() => void start(kind, true)}>
                  Taslağı koru, güncel durumu kontrol et
                </Button>
              )}
            </div>
          </form>
        )}
        {attempt && (
          <div className="policy-lifecycle-summary">
            <p>Sonuç doğrulanana kadar bilgiler korunuyor. Yeni bir işlem başlatmayın.</p>
            <Button disabled={busy} onClick={() => void execute(attempt)}>
              {attempt.result ? 'Kayıtlı sonucu doğrula' : 'Aynı işlemi tekrar kontrol et'}
            </Button>
          </div>
        )}
        {history.error && (
          <p role="alert">
            İşlem geçmişi okunamadı.{' '}
            <Button variant="outline" onClick={history.reload}>
              Geçmişi yenile
            </Button>
          </p>
        )}
        {Array.isArray(history.data) &&
          history.data.map((h) => (
            <div className="policy-lifecycle-summary" key={h.id}>
              <strong>
                {h.status === 'CANCELLED' ? 'İptal edildi' : 'Geçersiz kılındı'} ·{' '}
                {policyDate(h.eventDate)}
              </strong>
              <p>
                {({ ...cancellationReasons, ...voidReasons } as Record<string, string>)[
                  h.reasonCode
                ] ?? 'Eski kayıt'}
                {h.notes ? ` · ${h.notes}` : ''}
              </p>
            </div>
          ))}
        {policy.status !== 'ACTIVE' && history.data?.length === 0 && (
          <p>Eski kayıtta iptal / düzeltme ayrıntısı bulunmuyor.</p>
        )}
      </CardContent>
    </Card>
  );
}

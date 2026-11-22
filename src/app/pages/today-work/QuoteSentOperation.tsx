import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiResponse } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { parseAppError } from '../../App';
import { CustomerReadError, readCustomerResource } from '../customers/customer-resource';
import { policyMoney } from '../policies/policy-display';
import { interactionTime } from './interaction-model';
import {
  quoteMatches,
  exactQuoteUrl,
  quoteStatuses,
  savedPayload,
  type QuoteHistory,
  type QuoteRecord,
  type QuoteVersion,
} from './quote-model';
import type { QuoteRisk } from './RenewalQuotesSection';

interface Props {
  renewalId: string;
  renewalOpen: boolean;
  history: QuoteHistory | null;
  insurerNames: Record<string, string>;
  blocked: boolean;
  canOperate: () => boolean;
  compareRenewal: (signal: AbortSignal) => Promise<number | null>;
  onRisk: (risk: QuoteRisk) => void;
  onHistory: (history: QuoteHistory) => void;
  onDenied: () => void;
}
interface Target {
  renewalId: string;
  quoteId: string;
  label: string;
  openingCas: number;
  cas: number;
  version: QuoteVersion;
}
interface Attempt {
  url: string;
  method: 'POST';
  body: string;
  key: string;
  target: Target;
}
interface Result {
  operationId: string;
  quoteId: string;
  quoteVersionId: string;
  versionNumber: number;
  status: 'SENT';
}
interface Proof {
  attempt: Attempt;
  result: Result;
}
const explanation =
  'Bu işlem müşteriye otomatik mesaj göndermez. Teklifi başka bir kanaldan ilettiyseniz gönderildi olarak kaydedin.';
function entityId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
function current(q: QuoteRecord) {
  return q.versions?.find((v) => v.id === q.current_version_id);
}
function eligible(q: QuoteRecord, now = Date.now()) {
  const v = current(q);
  return (
    entityId(q.id) &&
    Number.isSafeInteger(q.version) &&
    q.version > 0 &&
    Number.isSafeInteger(q.version + 1) &&
    ['DRAFT', 'READY'].includes(q.status) &&
    !!v &&
    entityId(v.id) &&
    Number.isSafeInteger(v.version_number) &&
    v.version_number > 0 &&
    Number.isSafeInteger(v.gross_premium_minor) &&
    v.gross_premium_minor >= 0 &&
    entityId(v.insurer_id) &&
    entityId(v.product_id) &&
    typeof v.currency === 'string' &&
    /^[A-Z]{3}$/.test(v.currency) &&
    Date.parse(v.valid_until) > now
  );
}
function validResult(result: Result, attempt: Attempt) {
  return (
    !!result &&
    entityId(result.operationId) &&
    result.quoteId === attempt.target.quoteId &&
    result.quoteVersionId === attempt.target.version.id &&
    result.versionNumber === attempt.target.version.version_number &&
    result.status === 'SENT'
  );
}
function proven(h: QuoteHistory, proof: Proof): QuoteRecord | null {
  try {
    const { attempt: a, result: r } = proof;
    if (!validResult(r, a) || !Array.isArray(h.quotes)) return null;
    const matching = h.quotes.filter((q) => q.id === a.target.quoteId);
    if (matching.length !== 1) return null;
    const q = matching[0]!,
      v = q.versions.filter((v) => v.id === a.target.version.id);
    if (
      v.length !== 1 ||
      v[0]!.version_number !== r.versionNumber ||
      !quoteMatches(v[0]!, savedPayload(a.target.version)) ||
      !Number.isSafeInteger(q.version) ||
      q.version < a.target.cas + 1 ||
      !quoteStatuses[q.status] ||
      !current(q)
    )
      return null;
    if (
      q.version === a.target.cas + 1 &&
      (q.status !== 'SENT' || q.current_version_id !== a.target.version.id)
    )
      return null;
    const events = q.events.filter((e) => e.operation_receipt_id === r.operationId);
    if (events.length !== 1) return null;
    const event = events[0]!;
    if (
      !entityId(event.id) ||
      event.event !== 'SENT' ||
      event.quote_version_id !== r.quoteVersionId ||
      !Number.isFinite(Date.parse(event.occurred_at)) ||
      new Date(event.occurred_at).toISOString() !== event.occurred_at
    )
      return null;
    return q;
  } catch {
    return null;
  }
}
export function QuoteSentOperation(props: Props) {
  const root = `/api/renewals/${encodeURIComponent(props.renewalId)}/quotes`;
  const [opened, setOpened] = useState(false),
    [target, setTarget] = useState<Target | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [needsCompare, setNeedsCompare] = useState(false),
    [canSubmit, setCanSubmit] = useState(true),
    [visible, setVisible] = useState(true),
    [comparison, setComparison] = useState<QuoteRecord | null>(null),
    [attempt, setAttempt] = useState<Attempt | null>(null),
    [proof, setProof] = useState<Proof | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [verified, setVerified] = useState<Proof | null>(null);
  const lock = useRef(false),
    epoch = useRef(0),
    controllers = useRef(new Set<AbortController>()),
    heading = useRef<HTMLHeadingElement>(null);
  const dirty = opened || !!target,
    unresolved = !!attempt || !!proof || (busy && dirty);
  useEffect(() => {
    props.onRisk({ dirty, unresolved });
  }, [dirty, unresolved, props.onRisk]);
  useEffect(
    () => () => {
      epoch.current++;
      for (const c of controllers.current) c.abort();
    },
    [],
  );
  useEffect(() => {
    if (target) heading.current?.focus();
  }, [target?.quoteId, target?.version.id]);
  useEffect(() => {
    if (!props.history) {
      setVerified(null);
      setVisible(false);
      setConfirmed(false);
      if (target) setNeedsCompare(true);
    }
  }, [props.history, target]);
  const alive = (e: number, c: AbortController) => e === epoch.current && !c.signal.aborted;
  function denied() {
    setVisible(false);
    props.onDenied();
  }
  async function verify(p: Proof, c: AbortController, e: number) {
    try {
      const h = await readCustomerResource<QuoteHistory>(
        exactQuoteUrl(
          root,
          p.attempt.target.quoteId,
          p.attempt.target.version.id,
          p.result.operationId,
        ),
        c.signal,
      );
      if (!alive(e, c)) return;
      const q = proven(h, p);
      if (!q) throw new Error('SENT_PROOF_MISSING');
      props.onHistory(h);
      setProof(null);
      setTarget(null);
      setOpened(false);
      setConfirmed(false);
      setComparison(null);
      setError('');
      setVerified(p);
    } catch (cause) {
      if (!alive(e, c)) return;
      if (cause instanceof CustomerReadError && [401, 403, 404].includes(cause.status)) denied();
      setError(
        'Gönderildi kaydı kabul edildi; seçili teklif sürümünün geçmişteki sonucu henüz doğrulanamadı. Yalnız sonucu kontrol edin; kayıt yeniden gönderilmeyecek.',
      );
    }
  }
  async function transmit(a: Attempt) {
    if (lock.current || proof || props.blocked || !props.canOperate()) return;
    lock.current = true;
    setBusy(true);
    setAttempt(a);
    setError('');
    setVerified(null);
    props.onRisk({ dirty: true, unresolved: true });
    const e = epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    try {
      const token = await getCsrfToken(c.signal);
      if (!alive(e, c)) return;
      const r = await fetch(a.url, {
        method: a.method,
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token,
          'Idempotency-Key': a.key,
        },
        body: a.body,
      });
      if (!alive(e, c)) return;
      if (r.status === 401) {
        parseAppError(401);
        return;
      }
      const result = (await r.json().catch(() => null)) as ApiResponse<Result> | null;
      if (!alive(e, c)) return;
      if (!r.ok) {
        if (r.status >= 500 || [408, 429].includes(r.status)) throw new Error('UNCERTAIN');
        setAttempt(null);
        setConfirmed(false);
        if (r.status === 403) invalidateCsrfToken();
        if ([403, 404].includes(r.status)) denied();
        setNeedsCompare([403, 404, 409].includes(r.status));
        setError(
          r.status === 409
            ? 'Gönderildi kaydı çakıştı. Seçiminiz korundu; önceki ve güncel teklifi karşılaştırın. Yeniden onaylamadan kayıt gönderilmez.'
            : parseAppError(r.status, result && !result.success ? result.error : undefined).message,
        );
        return;
      }
      if (!result?.success || !validResult(result.data, a)) throw new Error('UNCERTAIN');
      setAttempt(null);
      const p = { attempt: a, result: result.data };
      setProof(p);
      await verify(p, c, e);
    } catch {
      if (alive(e, c))
        setError(
          'Gönderildi kaydının sonucu belirsiz. Seçtiğiniz teklif ve kayıt isteği korunuyor; yalnız aynı isteği yeniden deneyin. Sayfadan ayrılmak işlemi iptal etmez. Bu kayıt müşteriye teslimat kanıtı değildir.',
        );
    } finally {
      controllers.current.delete(c);
      lock.current = false;
      if (e === epoch.current) setBusy(false);
    }
  }
  async function recover() {
    if (!proof || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const e = epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    try {
      await verify(proof, c, e);
    } finally {
      controllers.current.delete(c);
      lock.current = false;
      if (e === epoch.current) setBusy(false);
    }
  }
  async function compare() {
    if (!target || lock.current || attempt || proof) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setConfirmed(false);
    const e = epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    try {
      const h = await readCustomerResource<QuoteHistory>(
        exactQuoteUrl(root, target.quoteId, target.version.id),
        c.signal,
      );
      if (!alive(e, c)) return;
      const renewal = await props.compareRenewal(c.signal);
      if (!alive(e, c)) return;
      const q = h.quotes.find((q) => q.id === target.quoteId),
        old = q?.versions.find((v) => v.id === target.version.id);
      const same =
        !!old &&
        old.version_number === target.version.version_number &&
        quoteMatches(old, savedPayload(target.version));
      props.onHistory(h);
      setComparison(q ? structuredClone(q) : null);
      setVisible(same);
      const allowed =
        renewal !== null &&
        props.renewalOpen &&
        !!q &&
        same &&
        q.current_version_id === target.version.id &&
        eligible(q);
      setCanSubmit(allowed);
      setNeedsCompare(false);
      if (allowed) setTarget((old) => (old ? { ...old, cas: q!.version } : old));
      else
        setError(
          'Seçili sürüm artık güncel/gönderilebilir değil veya yetkili görev yok. Hedef değiştirilmedi; yeni yazım kapalıdır. Başka sürüm için bu seçimi açıkça kapatıp yeniden seçim yapın.',
        );
    } catch (cause) {
      if (!alive(e, c)) return;
      if (cause instanceof CustomerReadError && [401, 403, 404].includes(cause.status)) denied();
      setError('Güncel teklif karşılaştırması okunamadı. Özgün seçim korunur; yazım yapılmadı.');
    } finally {
      controllers.current.delete(c);
      lock.current = false;
      if (e === epoch.current) setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !target ||
      lock.current ||
      attempt ||
      proof ||
      props.blocked ||
      needsCompare ||
      !canSubmit ||
      !visible ||
      !props.renewalOpen ||
      !props.canOperate()
    )
      return;
    if (!confirmed) {
      setError('Gönderildi beyanı için son açık onay gerekir.');
      return;
    }
    if (Date.parse(target.version.valid_until) <= Date.now()) {
      setError('Seçili teklif sürümünün geçerlilik süresi doldu; gönderildi olarak kaydedilemez.');
      return;
    }
    const snapshot = structuredClone(target);
    void transmit({
      url: `${root}/${encodeURIComponent(snapshot.quoteId)}/send`,
      method: 'POST',
      body: JSON.stringify({
        expectedQuoteVersion: snapshot.cas,
        quoteVersionId: snapshot.version.id,
      }),
      key: crypto.randomUUID(),
      target: snapshot,
    });
  }
  const locked = busy || !!attempt || !!proof;
  const choices = props.renewalOpen ? (props.history?.quotes.filter((q) => eligible(q)) ?? []) : [];
  // Initial receipt proof was exact and remains immutable. A bounded current page is not a full event archive.
  const verifiedCurrent =
    props.history && verified
      ? (props.history.quotes.find(
          (q) =>
            q.id === verified.attempt.target.quoteId &&
            q.version >= verified.attempt.target.cas + 1,
        ) ?? null)
      : null;
  function summary(v: QuoteVersion) {
    return (
      <dl className="today-task-facts">
        <div>
          <dt>Sigorta şirketi / ürün</dt>
          <dd>
            {props.insurerNames[v.insurer_id] ?? 'Şirket adı mevcut değil'} /{' '}
            {v.product_name ?? 'Ürün adı mevcut değil'}
          </dd>
        </div>
        <div>
          <dt>Brüt prim / para birimi</dt>
          <dd>{policyMoney(v.gross_premium_minor, v.currency)}</dd>
        </div>
        <div>
          <dt>Geçerlilik sonu (İstanbul)</dt>
          <dd>{interactionTime(v.valid_until) ?? 'Tarih mevcut değil'}</dd>
        </div>
      </dl>
    );
  }
  return (
    <section className="quote-sent-operation" aria-label="Teklif gönderildi beyanı">
      {!opened && choices.length > 0 && (
        <Button
          variant="outline"
          disabled={props.blocked}
          onClick={() => {
            if (props.blocked || lock.current || !props.canOperate()) return;
            props.onRisk({ dirty: true, unresolved: false });
            setOpened(true);
            setConfirmed(false);
            setCanSubmit(true);
            setNeedsCompare(false);
            setVisible(true);
            setError('');
            setVerified(null);
          }}
        >
          Teklifi gönderildi olarak kaydet
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      {verified && verifiedCurrent && (
        <p role="status">
          Gönderildi kaydı kaydedildi ve geçmişte doğrulandı. Kaydedilen sürüm{' '}
          {verified.result.versionNumber}; güncel teklif durumu:{' '}
          {quoteStatuses[verifiedCurrent.status]}.{' '}
          {verifiedCurrent.version > verified.attempt.target.cas + 1
            ? 'Daha sonraki değişiklikler var; tarihsel beyan güncel sürümün gönderildiği anlamına gelmez. '
            : ''}
          Bu kayıt dış teslimat kanıtı değildir.
        </p>
      )}
      {busy && <p role="status">Gönderildi beyanı doğrulanıyor…</p>}
      {opened && !target && (
        <>
          <p>{explanation}</p>
          <label htmlFor="sent-quote-choice">
            Gönderildi olarak kaydedilecek teklif ve güncel sürüm
          </label>
          <select
            id="sent-quote-choice"
            value=""
            disabled={props.blocked || locked}
            onChange={(event) => {
              const q = props.history?.quotes.find((q) => q.id === event.target.value);
              if (!q || !eligible(q) || !props.canOperate()) return;
              const v = current(q)!;
              setTarget({
                renewalId: props.renewalId,
                quoteId: q.id,
                label: `${props.insurerNames[v.insurer_id] ?? 'Şirket adı belirtilmemiş'} / ${v.product_name ?? 'Ürün adı belirtilmemiş'}`,
                openingCas: q.version,
                cas: q.version,
                version: structuredClone(v),
              });
              setConfirmed(false);
            }}
          >
            <option value="">Teklif ve güncel sürümü açıkça seçin</option>
            {choices.map((q) => (
              <option key={q.id} value={q.id}>
                {props.insurerNames[current(q)!.insurer_id] ?? 'Şirket adı belirtilmemiş'} ·{' '}
                {current(q)!.product_name ?? 'Ürün adı belirtilmemiş'} ·{' '}
                {policyMoney(current(q)!.gross_premium_minor, current(q)!.currency)}
              </option>
            ))}
          </select>
        </>
      )}
      {target && (
        <form
          className="interaction-form quote-send-form"
          aria-label="Gönderildi durum kaydı"
          onSubmit={submit}
        >
          <h4 ref={heading} tabIndex={-1}>
            Seçili teklif için gönderildi beyanı
          </h4>
          <p>{explanation}</p>
          <p>Teklifi görebilmek değiştirme yetkisi vermez; işlem yetkiniz ayrıca kontrol edilir.</p>
          {visible ? (
            <>
              <p>
                {target.label}. Gönderildi kaydı aşağıdaki fiyat içindir; fiyat daha sonra
                güncellenirse bu kayıt önceki fiyatın geçmişinde korunur.
              </p>
              {summary(target.version)}
            </>
          ) : (
            <p>
              Yetkili kayıt yeniden doğrulanana kadar seçimin ayrıntıları gizlidir. Özgün hedef
              bellekte korunur.
            </p>
          )}
          {comparison && visible && (
            <aside aria-label="Önceki ve güncel teklif karşılaştırması">
              <p>
                Önceki seçim: sürüm {target.version.version_number}, kayıt sürümü{' '}
                {target.openingCas}. Güncel teklif:{' '}
                {quoteStatuses[comparison.status] ?? 'Bilinmeyen durum'}, kayıt sürümü
                {comparison.version}, güncel sürüm{' '}
                {current(comparison)?.version_number ?? 'mevcut değil'}.
              </p>
              {current(comparison) && summary(current(comparison)!)}
              <p>İstek otomatik gönderilmez; uygunsa yeniden açık onay gerekir.</p>
            </aside>
          )}
          <label className="interaction-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={locked || props.blocked || needsCompare || !canSubmit || !visible}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            Seçili sürümü dış kanaldan ilettiğimi ve gönderildi kaydını onaylıyorum
          </label>
          <Button
            type="submit"
            disabled={locked || props.blocked || needsCompare || !canSubmit || !visible}
          >
            Gönderildi kaydını onayla
          </Button>
        </form>
      )}
      {attempt && (
        <Button disabled={busy || props.blocked} onClick={() => void transmit(attempt)}>
          Aynı gönderildi isteğini yeniden dene
        </Button>
      )}
      {proof && (
        <Button disabled={busy} onClick={() => void recover()}>
          Yalnız gönderildi kanıtını yeniden oku
        </Button>
      )}
      {needsCompare && !locked && (
        <Button variant="outline" onClick={() => void compare()}>
          Gönderildi kaydı için güncel teklifi karşılaştır
        </Button>
      )}
      {opened && !locked && (
        <Button
          variant="outline"
          onClick={() => {
            props.onRisk({ dirty: false, unresolved: false });
            setOpened(false);
            setTarget(null);
            setConfirmed(false);
            setNeedsCompare(false);
            setComparison(null);
            setError('');
          }}
        >
          Gönderildi seçimini açıkça kapat
        </Button>
      )}
    </section>
  );
}

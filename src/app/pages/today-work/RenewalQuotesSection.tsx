import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiResponse, SelectableCatalogsDto } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { parseAppError } from '../../App';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { CustomerReadError, readCustomerResource } from '../customers/customer-resource';
import { premiumInput } from '../policies/policy-form-model';
import { interactionTime } from './interaction-model';
import { QuoteSentOperation } from './QuoteSentOperation';
import {
  quoteDraft,
  quotePayload,
  quoteMatches,
  savedPayload,
  quoteStatuses,
  type QuoteHistory,
  type QuoteRecord,
  type QuoteDraft,
  type VersionPayload,
} from './quote-model';
export interface QuoteRisk {
  dirty: boolean;
  unresolved: boolean;
}
interface Props {
  renewalId: string;
  renewalVersion: number;
  renewalOpen: boolean;
  canOperate: () => boolean;
  compareRenewal: (signal: AbortSignal) => Promise<number | null>;
  onRisk: (risk: QuoteRisk) => void;
}
type Kind = 'create' | 'version';
interface Form {
  kind: Kind;
  openingRenewalVersion: number;
  openingQuoteVersion: number | null;
  offerInsurerId: string;
  offerProductId: string;
  renewalId: string;
  renewalVersion: number;
  quoteId: string | null;
  quoteVersion: number | null;
  nextNumber: number;
  branchId: string;
  knownQuoteIds: string[];
  knownVersionIds: string[];
  draft: QuoteDraft;
  confirmed: boolean;
  needsCompare: boolean;
  comparison: string | null;
  eligible: boolean;
}
interface Result {
  operationId: string;
  quoteId: string;
  quoteVersionId: string;
  versionNumber: number;
  status: string;
}
interface Attempt {
  kind: Kind;
  url: string;
  method: 'POST';
  body: string;
  key: string;
  snapshot: Form;
  payload: VersionPayload;
}
function id(s: unknown): s is string {
  return typeof s === 'string' && s.trim() === s && s.length > 0 && s.length <= 128;
}
function validResult(r: Result, a: Attempt) {
  return (
    !!r &&
    id(r.operationId) &&
    id(r.quoteId) &&
    id(r.quoteVersionId) &&
    r.status === 'DRAFT' &&
    r.versionNumber === a.snapshot.nextNumber &&
    (a.kind === 'create'
      ? !a.snapshot.knownQuoteIds.includes(r.quoteId)
      : r.quoteId === a.snapshot.quoteId) &&
    !a.snapshot.knownVersionIds.includes(r.quoteVersionId)
  );
}
function historyShape(h: QuoteHistory) {
  if (!h || !Array.isArray(h.quotes) || !h.defaultVersion) return false;
  try {
    quoteDraft(h.defaultVersion);
    return h.quotes.every(
      (q) =>
        id(q.id) &&
        Number.isSafeInteger(q.version) &&
        q.version > 0 &&
        typeof q.status === 'string' &&
        Array.isArray(q.versions) &&
        Array.isArray(q.events) &&
        q.versions.every(
          (v) =>
            id(v.id) &&
            Number.isSafeInteger(v.version_number) &&
            Number.isSafeInteger(v.gross_premium_minor) &&
            v.gross_premium_minor >= 0,
        ),
    );
  } catch {
    return false;
  }
}
function QuoteWorkspace(props: Props) {
  const root = `/api/renewals/${encodeURIComponent(props.renewalId)}/quotes`;
  const [opened, setOpened] = useState(false),
    [data, setData] = useState<QuoteHistory | null>(null),
    [catalogs, setCatalogs] = useState<SelectableCatalogsDto | null>(null),
    [names, setNames] = useState<Record<string, string>>({}),
    [form, setForm] = useState<Form | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [catalogError, setCatalogError] = useState('');
  const [createPending, setCreatePending] = useState<Attempt | null>(null),
    [versionPending, setVersionPending] = useState<Attempt | null>(null),
    [saved, setSaved] = useState<{ attempt: Attempt; result: Result } | null>(null);
  const [sentRisk, setSentRisk] = useState<QuoteRisk>({ dirty: false, unresolved: false });
  const sentRiskRef = useRef(sentRisk);
  const pending = createPending ?? versionPending,
    lock = useRef(false),
    epoch = useRef(0),
    readGeneration = useRef(0),
    controllers = useRef(new Set<AbortController>()),
    formHeading = useRef<HTMLHeadingElement>(null),
    historyHeading = useRef<HTMLHeadingElement>(null);
  const risk: QuoteRisk = {
    dirty: !!form || sentRisk.dirty,
    unresolved: !!pending || !!saved || (busy && !!form) || sentRisk.unresolved,
  };
  useEffect(() => {
    props.onRisk(risk);
  }, [risk.dirty, risk.unresolved, props.onRisk]);
  useEffect(
    () => () => {
      epoch.current++;
      for (const c of controllers.current) c.abort();
    },
    [],
  );
  useEffect(() => {
    if (form) formHeading.current?.focus();
  }, [form?.kind, form?.quoteId]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (risk.dirty || risk.unresolved) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [risk.dirty, risk.unresolved]);
  function setPending(a: Attempt | null, kind: Kind) {
    if (kind === 'create') setCreatePending(a);
    else setVersionPending(a);
  }
  async function readCatalogs(signal: AbortSignal, h: QuoteHistory) {
    try {
      const cats = await readCustomerResource<SelectableCatalogsDto>(
        '/api/catalogs/selectable',
        signal,
      );
      if (![cats.insurers, cats.products, cats.branches, cats.paymentMethods].every(Array.isArray))
        throw new Error('CATALOG_SHAPE');
      const resolved: Record<string, string> = {};
      for (const insurer of cats.insurers) resolved[insurer.id] = insurer.name;
      // Resolve authorized historical insurer labels only for this selected renewal; never invent names.
      for (const missing of new Set(
        h.quotes
          .flatMap((q) => q.versions.map((v) => v.insurer_id))
          .filter((key) => id(key) && !resolved[key]),
      )) {
        try {
          const row = await readCustomerResource<{ id: string; name: string }>(
            `/api/catalogs/resolve/insurer/${encodeURIComponent(missing)}`,
            signal,
          );
          if (row.id === missing && typeof row.name === 'string') resolved[missing] = row.name;
        } catch {
          if (signal.aborted) throw new Error('ABORTED');
        }
      }
      return { catalogs: cats, names: resolved };
    } catch {
      return null;
    }
  }
  async function load(proof?: { attempt: Attempt; result: Result }, compare = false) {
    if (lock.current && !proof) return;
    const e = epoch.current,
      g = ++readGeneration.current,
      c = new AbortController();
    controllers.current.add(c);
    setBusy(true);
    setError('');
    try {
      const h = await readCustomerResource<QuoteHistory>(root, c.signal);
      if (!historyShape(h)) throw new Error('HISTORY_SHAPE');
      if (e !== epoch.current || c.signal.aborted || g !== readGeneration.current) return;
      if (proof) {
        const { attempt: a, result: r } = proof,
          q = h.quotes.find((q) => q.id === r.quoteId),
          v = q?.versions.find((v) => v.id === r.quoteVersionId);
        if (
          !q ||
          !v ||
          v.version_number !== r.versionNumber ||
          !quoteMatches(v, a.payload) ||
          !q.versions.some(
            (item) =>
              item.version_number === 1 &&
              item.insurer_id === a.payload.insurerId &&
              item.product_id === a.payload.productId,
          ) ||
          !q.versions.some((item) => item.id === q.current_version_id) ||
          q.version < (a.kind === 'create' ? 1 : a.snapshot.quoteVersion! + 1) ||
          (q.version === (a.kind === 'create' ? 1 : a.snapshot.quoteVersion! + 1) &&
            (q.current_version_id !== r.quoteVersionId || q.status !== 'DRAFT'))
        )
          throw new Error('READBACK_PROOF_MISSING');
        setData(h);
        setSaved(null);
        setForm(null);
        setSuccess('Teklif yetkili geçmiş okumasıyla doğrulandı.');
        historyHeading.current?.focus();
        return;
      }
      const cat = await readCatalogs(c.signal, h);
      if (e !== epoch.current || c.signal.aborted || g !== readGeneration.current) return;
      setCatalogs(cat?.catalogs ?? null);
      setNames(cat?.names ?? {});
      setCatalogError(
        cat
          ? ''
          : 'Teklif kataloglarına erişilemiyor. Geçmiş salt okunabilir; yeni yazım için yetkili kataloglar gerekir.',
      );
      setData(h);
      if (compare && form) {
        const version = await props.compareRenewal(c.signal);
        if (e !== epoch.current || c.signal.aborted || g !== readGeneration.current) return;
        const target = form.kind === 'version' ? h.quotes.find((q) => q.id === form.quoteId) : null;
        const eligible =
          version !== null &&
          props.renewalOpen &&
          (form.kind === 'create' ||
            (!!target &&
              target.status !== 'ACCEPTED' &&
              !!target.current_version_id &&
              target.versions.some(
                (v) =>
                  v.version_number === 1 &&
                  v.insurer_id === form.offerInsurerId &&
                  v.product_id === form.offerProductId,
              )));
        setForm((old) =>
          old
            ? {
                ...old,
                renewalVersion: version ?? old.renewalVersion,
                quoteVersion: target?.version ?? old.quoteVersion,
                nextNumber: target
                  ? Math.max(...target.versions.map((v) => v.version_number)) + 1
                  : old.nextNumber,
                knownQuoteIds: h.quotes.map((q) => q.id),
                knownVersionIds: h.quotes.flatMap((q) => q.versions.map((v) => v.id)),
                confirmed: false,
                needsCompare: false,
                eligible,
                comparison: eligible
                  ? `Güncel yenileme v${version}${target ? `, teklif v${target.version}` : ''} okundu. Taslak korunur; alanları karşılaştırıp yeniden onaylayın.`
                  : 'Hedef veya yetkili görev artık uygun değil. Başka teklife geçilmez; yeni yazım kapalıdır.',
              }
            : null,
        );
      }
    } catch (cause) {
      if (e !== epoch.current || c.signal.aborted || g !== readGeneration.current) return;
      const denied = cause instanceof CustomerReadError && [401, 403, 404].includes(cause.status);
      if (denied) {
        setData(null);
        setCatalogs(null);
        setNames({});
      }
      setError(
        proof
          ? 'Yazım doğrulandı, ancak teklif geçmişindeki kimlik/sürüm/içerik kanıtı okunamadı. Yalnız GET yeniden denenecek.'
          : denied
            ? 'Teklif geçmişine erişilemiyor. İletişim ve görev izinleri ayrıdır. Taslak varsa yalnız bu bölümün belleğinde korunur.'
            : 'Teklif geçmişi yüklenemedi. Yetkili okumayı yeniden deneyin.',
      );
    } finally {
      controllers.current.delete(c);
      if (e === epoch.current && g === readGeneration.current) setBusy(false);
    }
  }
  function open(kind: Kind, q?: QuoteRecord) {
    if (
      !data ||
      !catalogs ||
      lock.current ||
      pending ||
      saved ||
      form ||
      sentRiskRef.current.dirty ||
      sentRiskRef.current.unresolved ||
      !props.renewalOpen ||
      !props.canOperate()
    )
      return;
    const current = q?.versions.find((v) => v.id === q.current_version_id);
    const original = q?.versions.find((v) => v.version_number === 1);
    if (kind === 'version' && (!q || q.status === 'ACCEPTED' || !current || !original)) return;
    setSuccess('');
    setError('');
    setForm({
      kind,
      openingRenewalVersion: props.renewalVersion,
      openingQuoteVersion: q?.version ?? null,
      offerInsurerId: original?.insurer_id ?? data.defaultVersion.insurerId,
      offerProductId: original?.product_id ?? data.defaultVersion.productId,
      renewalId: props.renewalId,
      renewalVersion: props.renewalVersion,
      quoteId: q?.id ?? null,
      quoteVersion: q?.version ?? null,
      nextNumber: q ? Math.max(...q.versions.map((v) => v.version_number)) + 1 : 1,
      branchId: data.defaultVersion.branchId,
      knownQuoteIds: data.quotes.map((q) => q.id),
      knownVersionIds: data.quotes.flatMap((q) => q.versions.map((v) => v.id)),
      draft: quoteDraft(
        current && original
          ? {
              ...savedPayload(current),
              insurerId: original.insurer_id,
              productId: original.product_id,
              branchId: original.branch_id,
            }
          : data.defaultVersion,
      ),
      confirmed: false,
      needsCompare: false,
      comparison: null,
      eligible: true,
    });
  }
  async function send(a: Attempt) {
    if (lock.current || saved || !props.canOperate()) return;
    lock.current = true;
    setBusy(true);
    setPending(a, a.kind);
    setError('');
    setSuccess('');
    const e = epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    try {
      const token = await getCsrfToken(c.signal);
      if (e !== epoch.current || c.signal.aborted) return;
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
      if (e !== epoch.current) return;
      if (r.status === 401) {
        parseAppError(401);
        return;
      }
      const envelope = (await r.json().catch(() => null)) as ApiResponse<Result> | null;
      if (e !== epoch.current) return;
      if (!r.ok) {
        if (r.status >= 500 || [408, 429].includes(r.status)) throw new Error('UNCERTAIN');
        setPending(null, a.kind);
        if (r.status === 403) invalidateCsrfToken();
        if ([403, 404].includes(r.status)) {
          setData(null);
          setCatalogs(null);
          setNames({});
        }
        setForm((old) =>
          old
            ? {
                ...old,
                confirmed: false,
                needsCompare: [403, 404, 409].includes(r.status) || old.needsCompare,
              }
            : old,
        );
        setError(
          r.status === 409
            ? 'Teklif veya yenileme durumu değişti. Taslak korundu; güncel yetkili bilgileri karşılaştırıp yeniden onaylayın.'
            : parseAppError(r.status, envelope && !envelope.success ? envelope.error : undefined)
                .message,
        );
        return;
      }
      if (!envelope?.success || !validResult(envelope.data, a)) throw new Error('UNCERTAIN');
      setPending(null, a.kind);
      const proof = { attempt: a, result: envelope.data };
      setSaved(proof);
      await load(proof);
    } catch {
      if (e === epoch.current && !c.signal.aborted)
        setError(
          'Teklif yazımının sonucu belirsiz. Prim, son geçerlilik, URL/body/anahtar donduruldu; yalnız aynı isteği yeniden deneyin. Ayrılmak işlemi iptal etmez.',
        );
    } finally {
      controllers.current.delete(c);
      lock.current = false;
      if (e === epoch.current) setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !form ||
      !data ||
      !catalogs ||
      busy ||
      lock.current ||
      pending ||
      saved ||
      form.needsCompare ||
      sentRiskRef.current.dirty ||
      sentRiskRef.current.unresolved ||
      !form.eligible ||
      !props.canOperate()
    )
      return;
    if (!form.confirmed) {
      setError('Yeni kalıcı kayıt için açık onay gerekir.');
      return;
    }
    const payload = quotePayload(form.draft, catalogs, form.branchId);
    if (
      form.kind === 'version' &&
      (form.draft.insurerId !== form.offerInsurerId || form.draft.productId !== form.offerProductId)
    ) {
      setError(
        'Farklı şirket veya ürün için ayrı teklif oluşturun. Bu hedefin şirket/ürün kimliği sabittir.',
      );
      return;
    }
    if (!payload) {
      setError(
        'Etkin katalog ilişkileri, gerçek kapsam tarihleri, gelecekteki İstanbul geçerlilik zamanı, ISO para birimi, tam kuruş tutarı, taksit ve en fazla1000 karakter koşulları denetleyin.',
      );
      return;
    }
    const body =
      form.kind === 'create'
        ? { expectedRenewalVersion: form.renewalVersion, version: payload }
        : { expectedQuoteVersion: form.quoteVersion, version: payload };
    void send({
      kind: form.kind,
      url: form.kind === 'create' ? root : `${root}/${encodeURIComponent(form.quoteId!)}/versions`,
      method: 'POST',
      body: JSON.stringify(body),
      key: crypto.randomUUID(),
      snapshot: structuredClone(form),
      payload,
    });
  }
  const locked = busy || !!pending || !!saved || sentRisk.dirty || sentRisk.unresolved;
  const changed = (key: keyof QuoteDraft, value: string) =>
    setForm((old) =>
      old
        ? {
            ...old,
            draft: {
              ...old.draft,
              [key]: value,
              ...(key === 'insurerId' || key === 'branchId' ? { productId: '' } : {}),
            },
            confirmed: false,
          }
        : old,
    );
  const textField = (key: keyof QuoteDraft, label: string, type = 'text') => (
    <>
      <label htmlFor={'quote-' + key}>{label}</label>
      <Input
        id={'quote-' + key}
        type={type}
        step={key === 'validUntil' ? '0.001' : undefined}
        value={form!.draft[key]}
        onChange={(e) => changed(key, e.target.value)}
      />
    </>
  );
  const selectField = (
    key: keyof QuoteDraft,
    label: string,
    rows: readonly { id: string; name: string }[],
  ) => {
    const value = form!.draft[key];
    return (
      <>
        <label htmlFor={'quote-' + key}>{label}</label>
        <select
          id={'quote-' + key}
          value={value}
          disabled={
            form?.kind === 'version' &&
            (key === 'insurerId' || key === 'productId' || key === 'branchId')
          }
          onChange={(e) => changed(key, e.target.value)}
        >
          <option value="">Açıkça seçin</option>
          {value && !rows.some((row) => row.id === value) && (
            <option value={value} disabled>
              Önceki değer seçilebilir katalogda yok
            </option>
          )}
          {rows.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </>
    );
  };
  return (
    <section className="renewal-interactions quote-section" aria-label="Teklifler">
      <h3 ref={historyHeading} tabIndex={-1}>
        Teklifler
      </h3>
      <p>
        Teklif okuma ve yönetme izinleri ayrı doğrulanır. Gönderildi durumu dış mesaj teslimatının
        kanıtı değildir. Burada mesaj/belge gönderilmez; kabul/ret veya yenileme sonucu işlemi
        yapılmaz. Farklı sigorta şirketi veya ürün alternatifi için yeni teklif oluşturun; sürüm
        işlemi aynı teklifin ilk kayıtlı şirket/ürün kimliğini korur.
      </p>
      {!opened ? (
        <Button
          variant="outline"
          onClick={() => {
            setOpened(true);
            void load();
          }}
        >
          Teklif geçmişini aç
        </Button>
      ) : (
        <Button variant="outline" disabled={locked || !!form} onClick={() => void load()}>
          Teklif geçmişini ve katalogları yeniden oku
        </Button>
      )}
      {busy && <p role="status">Teklif bilgileri işleniyor…</p>}
      {error && <p role="alert">{error}</p>}
      {success && <p role="status">{success}</p>}
      {catalogError && <p>{catalogError}</p>}
      {opened && (
        <QuoteSentOperation
          renewalId={props.renewalId}
          renewalOpen={props.renewalOpen}
          history={data}
          insurerNames={names}
          blocked={busy || !!form || !!pending || !!saved}
          canOperate={() => !lock.current && !form && !pending && !saved && props.canOperate()}
          compareRenewal={props.compareRenewal}
          onHistory={(history) => setData(history)}
          onDenied={() => {
            setData(null);
            setCatalogs(null);
            setNames({});
          }}
          onRisk={(next) => {
            if (next.dirty && !sentRiskRef.current.dirty) setSuccess('');
            sentRiskRef.current = next;
            setSentRisk((old) =>
              old.dirty === next.dirty && old.unresolved === next.unresolved ? old : next,
            );
          }}
        />
      )}
      {pending && (
        <Button disabled={busy} onClick={() => void send(pending)}>
          Aynı {pending.kind === 'create' ? 'teklif' : 'sürüm'} isteğini yeniden dene
        </Button>
      )}
      {saved && (
        <Button disabled={busy} onClick={() => void load(saved)}>
          Yalnız teklif geçmişini yeniden oku
        </Button>
      )}
      {form && (
        <>
          <p>
            Taslak yalnız bellektedir.{' '}
            {form.kind === 'create'
              ? `İlk yenileme v${form.openingRenewalVersion}; gönderim snapshot v${form.renewalVersion}`
              : `Sabit hedef teklif; ilk quote CAS v${form.openingQuoteVersion}, gönderim CAS v${form.quoteVersion}; önerilen yeni değişmez sürüm ${form.nextNumber}`}
            . Kayıtlı sürümler düzenlenmez.
            {form.kind === 'version' &&
              ' Şirket/ürün kimliği sabittir; farklı alternatif için ayrı yeni teklif oluşturun.'}
          </p>
          {!locked && (
            <Button
              variant="outline"
              onClick={() => {
                setForm(null);
                setError('');
                setSuccess('');
                historyHeading.current?.focus();
              }}
            >
              Teklif taslağını açıkça bırak
            </Button>
          )}
          {form.needsCompare && !locked && (
            <Button variant="outline" onClick={() => void load(undefined, true)}>
              Güncel teklif durumunu karşılaştır
            </Button>
          )}
          {form.comparison && <p role="status">{form.comparison}</p>}
        </>
      )}
      {data && (
        <>
          <div className="quote-history">
            {!data.quotes.length && <p>Henüz teklif kaydı bulunmuyor.</p>}
            {data.quotes.map((q, index) => (
              <article key={q.id} className="quote-record" aria-label={`Teklif ${index + 1}`}>
                <h4>
                  Teklif {index + 1} — {quoteStatuses[q.status] ?? q.status}
                </h4>
                <p>
                  Kayıt sürümü {q.version} ·{' '}
                  {interactionTime(q.created_at) ?? 'Kayıt tarihi mevcut değil'}
                </p>
                {q.versions.map((v) => (
                  <details key={v.id} open={v.id === q.current_version_id}>
                    <summary>
                      Sürüm {v.version_number} —{' '}
                      {v.id === q.current_version_id
                        ? 'Güncel kayıtlı sürüm'
                        : 'Tarihsel değişmez sürüm'}
                      {v.id === q.accepted_version_id ? ' · Kabul edilmiş sürüm' : ''}
                    </summary>
                    {v.id === q.current_version_id &&
                      Number.isFinite(Date.parse(v.valid_until)) &&
                      Date.parse(v.valid_until) <= Date.now() && (
                        <p className="quote-expiry-notice">
                          Bu sürümün geçerliliği sona erdi; gönderildi veya kabul kaydı için
                          seçilemez. Yenileme açıksa ve yetkiniz varsa aşağıdaki yeni sürüm
                          işlemiyle güncel bir teklif hazırlayın. Kayıtlı teklif durumu
                          değiştirilmedi.
                        </p>
                      )}
                    <dl className="today-task-facts">
                      <div>
                        <dt>Sigorta şirketi / ürün</dt>
                        <dd>
                          {names[v.insurer_id] ?? 'Şirket adı mevcut değil'} /{' '}
                          {v.product_name ?? 'Ürün adı mevcut değil'}
                        </dd>
                      </div>
                      <div>
                        <dt>Kapsam</dt>
                        <dd>
                          {v.start_date} — {v.end_date}
                        </dd>
                      </div>
                      <div>
                        <dt>Geçerlilik sonu (İstanbul)</dt>
                        <dd>{interactionTime(v.valid_until) ?? 'Tarih mevcut değil'}</dd>
                      </div>
                      <div>
                        <dt>Brüt prim</dt>
                        <dd>
                          {premiumInput(v.gross_premium_minor)} {v.currency}
                        </dd>
                      </div>
                      <div>
                        <dt>Taksit sayısı</dt>
                        <dd>{v.installment_count ?? 'Taksit belirtilmemiş'}</dd>
                      </div>
                    </dl>
                    {v.terms_summary !== null && (
                      <p className="interaction-note">{v.terms_summary}</p>
                    )}
                    <p>{interactionTime(v.created_at) ?? 'Sürüm kayıt tarihi mevcut değil'}</p>
                  </details>
                ))}
                <ul
                  className="interaction-timeline"
                  aria-label={`Teklif ${index + 1} tarihsel olayları`}
                >
                  {q.events.map((event) => (
                    <li key={event.id}>
                      {quoteStatuses[event.event] ?? event.event} ·{' '}
                      {interactionTime(event.occurred_at) ?? 'Olay tarihi mevcut değil'}
                      {event.quote_version_id &&
                      q.versions.some((v) => v.id === event.quote_version_id)
                        ? ` · Sürüm ${q.versions.find((v) => v.id === event.quote_version_id)!.version_number}`
                        : ''}
                    </li>
                  ))}
                </ul>
                {!form && q.status !== 'ACCEPTED' && props.renewalOpen && (
                  <Button
                    variant="outline"
                    disabled={
                      locked || !catalogs || !q.versions.some((v) => v.id === q.current_version_id)
                    }
                    onClick={() => open('version', q)}
                  >
                    Teklif {index + 1} için yeni değişmez sürüm taslağı aç
                  </Button>
                )}
                {q.status === 'ACCEPTED' && (
                  <p>Kabul edilmiş teklif salt okunur; yeni sürüm oluşturulamaz.</p>
                )}
              </article>
            ))}
          </div>
          {!form && props.renewalOpen && (
            <Button disabled={locked || !catalogs} onClick={() => open('create')}>
              Yeni teklif taslağı aç
            </Button>
          )}
          {form && catalogs && (
            <form
              className="interaction-form quote-form"
              aria-label={
                form.kind === 'create' ? 'Yeni teklif formu' : 'Yeni değişmez sürüm formu'
              }
              noValidate
              onSubmit={submit}
            >
              <h4 ref={formHeading} tabIndex={-1}>
                {form.kind === 'create' ? 'Yeni teklif önerisi' : 'Yeni değişmez sürüm önerisi'}
              </h4>
              <p>
                Sunucu varsayımları yalnız öneridir. Kapsam/prim/geçerlilik/koşulları inceleyin;
                formdaki değişiklikler henüz kaydedilmemiş taslaktır. Branş mevcut yenilemenin
                branşıyla sınırlıdır.
              </p>
              <fieldset disabled={locked || form.needsCompare || !form.eligible}>
                {selectField(
                  'insurerId',
                  'Teklif sigorta şirketi',
                  catalogs.insurers.filter((i) => i.status === 'ACTIVE'),
                )}
                {selectField(
                  'branchId',
                  'Teklif branşı',
                  catalogs.branches.filter((b) => b.id === form.branchId && b.status === 'ACTIVE'),
                )}
                {selectField(
                  'productId',
                  'Teklif ürünü',
                  catalogs.products.filter(
                    (p) =>
                      p.status === 'ACTIVE' &&
                      p.insurerId === form.draft.insurerId &&
                      p.branchId === form.draft.branchId,
                  ),
                )}
                {selectField(
                  'paymentMethodId',
                  'Teklif ödeme yöntemi',
                  catalogs.paymentMethods.filter((m) => m.status === 'ACTIVE'),
                )}
                {textField('startDate', 'Teklif kapsam başlangıcı', 'date')}
                {textField('endDate', 'Teklif kapsam bitişi', 'date')}
                {textField('validUntil', 'Teklif geçerlilik sonu (İstanbul)', 'datetime-local')}
                {textField('premium', 'Teklif brüt primi (ana birim)')}
                {textField('currency', 'Teklif para birimi (ISO)')}
                {textField('installmentCount', 'Teklif taksit sayısı (yoksa boş)')}
                <label htmlFor="quote-terms">Teklif koşulları</label>
                <textarea
                  id="quote-terms"
                  maxLength={1000}
                  value={form.draft.termsSummary}
                  onChange={(e) => changed('termsSummary', e.target.value)}
                />
                <label className="interaction-confirm">
                  <input
                    type="checkbox"
                    checked={form.confirmed}
                    onChange={(e) =>
                      setForm((old) => (old ? { ...old, confirmed: e.target.checked } : old))
                    }
                  />
                  {form.kind === 'create'
                    ? 'Yeni teklif kaydını oluşturmayı onaylıyorum'
                    : 'Mevcut sürümü değiştirmeden yeni sürüm oluşturmayı onaylıyorum'}
                </label>
              </fieldset>
              <Button disabled={locked || form.needsCompare || !form.eligible} type="submit">
                {form.kind === 'create' ? 'Teklifi oluştur' : 'Yeni değişmez sürümü oluştur'}
              </Button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
export function RenewalQuotesSection(props: Props) {
  return <QuoteWorkspace key={props.renewalId} {...props} />;
}

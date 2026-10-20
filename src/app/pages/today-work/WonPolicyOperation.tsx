import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  ApiResponse,
  PolicyDetailDto,
  PolicyListResponseData,
  TodayTaskDto,
} from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { completionMoney } from '../../components/RenewalPolicySelector';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { parseAppError } from '../../App';
import { CustomerReadError, readCustomerResource } from '../customers/customer-resource';
import type { TaskOperationRisk, TaskReadback } from './TaskOperationsSection';
import type { QuoteRecord, QuoteVersion } from './quote-model';
import { WonCreatePolicyForm, type CreateReview } from './WonCreatePolicyForm';
import { premiumMinor } from '../policies/policy-form-model';
interface Props {
  mode?: 'LINK_POLICY' | 'CREATE_POLICY';
  task: TodayTaskDto;
  read: (signal: AbortSignal) => Promise<TaskReadback>;
  canOperate: () => boolean;
  blocked: () => boolean;
  onRisk: (risk: TaskOperationRisk) => void;
  onApplied: (message: string) => void;
}
interface Quote extends QuoteRecord {
  accepted_policy_id: string | null;
  events: (QuoteRecord['events'][number] & { accepted_policy_id?: string | null })[];
}
interface SelectedQuote {
  quoteId: string;
  quoteCas: number;
  version: QuoteVersion;
}
interface Attempt {
  readonly target: TodayTaskDto;
  readonly policy: PolicyDetailDto | null;
  readonly create?: CreateReview;
  readonly quote: SelectedQuote | null;
  readonly url: string;
  readonly method: 'POST';
  readonly body: string;
  readonly key: string;
}
interface WonResult {
  renewalId: string;
  primaryTaskId: string;
  previousState: string;
  state: string;
  renewalVersion: number;
  taskVersion: number;
  closedAt: string;
  createdPolicyId: string | null;
  acceptedQuoteVersionId: string | null;
  acceptedPolicyId: string | null;
  newPolicyIds: string[];
  linkIds: string[];
  links: {
    id: string;
    newPolicyId: string;
    allocatedNewPremiumMinor: number;
    currency: string;
    differentPolicyholderReasonCode: string | null;
  }[];
}
const canonical = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const dateOnly = (v: unknown) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && canonical(v + 'T00:00:00.000Z');
const open = (t: TodayTaskDto) => !['WON', 'LOST', 'VOIDED'].includes(t.renewalState);
const sameTask = (a: TodayTaskDto, b: TodayTaskDto) =>
  a.taskId === b.taskId && a.renewalId === b.renewalId && a.customerId === b.customerId;
function validPolicy(p: PolicyDetailDto, id: string, customer: string, agency?: string) {
  return (
    p?.id === id &&
    p.customerId === customer &&
    p.customer?.id === customer &&
    !!p.agencyId &&
    (!agency || p.agencyId === agency) &&
    p.status === 'ACTIVE' &&
    p.archivedAt === null &&
    Number.isSafeInteger(p.version) &&
    p.version > 0 &&
    Number.isSafeInteger(p.grossPremiumMinor) &&
    p.grossPremiumMinor >= 0 &&
    /^[A-Z]{3}$/.test(p.currency) &&
    !!p.policyNumber &&
    !!p.insurerId &&
    p.insurer?.id === p.insurerId &&
    !!p.productId &&
    p.product?.id === p.productId &&
    dateOnly(p.startDate) &&
    dateOnly(p.endDate) &&
    p.endDate > p.startDate
  );
}
function samePolicy(a: PolicyDetailDto, b: PolicyDetailDto) {
  return [
    'id',
    'agencyId',
    'customerId',
    'version',
    'policyNumber',
    'insurerId',
    'productId',
    'startDate',
    'endDate',
    'grossPremiumMinor',
    'currency',
    'status',
    'archivedAt',
  ].every((k) => a[k as keyof PolicyDetailDto] === b[k as keyof PolicyDetailDto]);
}
function createdPolicyMatches(p: PolicyDetailDto, id: string, c: CreateReview) {
  return (
    p?.id === id &&
    p.agencyId === c.agencyId &&
    p.customer?.id === c.policy.customerId &&
    p.archivedAt === null &&
    p.version === 1 &&
    p.insurer?.id === c.policy.insurerId &&
    p.product?.id === c.policy.productId &&
    Number.isSafeInteger(p.grossPremiumMinor) &&
    BigInt(p.grossPremiumMinor) === premiumMinor(c.policy.grossPremium) &&
    Object.entries(c.policy).every(
      ([k, v]) => k === 'grossPremium' || p[k as keyof PolicyDetailDto] === v,
    )
  );
}
function eligible(q: Quote): SelectedQuote | null {
  if (
    !q?.id ||
    q.status !== 'SENT' ||
    !Number.isSafeInteger(q.version) ||
    !Array.isArray(q.versions) ||
    !Array.isArray(q.events)
  )
    return null;
  const vs = q.versions.filter((v) => v.id === q.current_version_id);
  if (vs.length !== 1) return null;
  const v = vs[0]!;
  if (
    !canonical(v.valid_until) ||
    Date.parse(v.valid_until) <= Date.now() ||
    !v.product_id ||
    !Number.isSafeInteger(v.gross_premium_minor) ||
    v.gross_premium_minor < 0 ||
    !/^[A-Z]{3}$/.test(v.currency) ||
    !q.events.some((e) => e.event === 'SENT' && e.quote_version_id === v.id)
  )
    return null;
  return { quoteId: q.id, quoteCas: q.version, version: structuredClone(v) };
}
const differences = (p: PolicyDetailDto, q: SelectedQuote) =>
  [
    p.productId !== q.version.product_id ? 'Ürün farklı' : null,
    p.grossPremiumMinor !== q.version.gross_premium_minor ? 'Brüt prim farklı' : null,
    p.currency !== q.version.currency ? 'Para birimi farklı' : null,
  ].filter(Boolean);
function proof(value: unknown, a: Attempt): value is WonResult {
  if (!value || typeof value !== 'object') return false;
  const r = value as WonResult,
    p = a.create
      ? {
          id: r.createdPolicyId,
          grossPremiumMinor: Number(premiumMinor(a.create.policy.grossPremium)),
          currency: a.create.policy.currency,
        }
      : a.policy,
    t = a.target;
  if (
    !p ||
    (a.create &&
      (typeof r.createdPolicyId !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(r.createdPolicyId) ||
        r.createdPolicyId === t.policyId))
  )
    return false;
  return (
    r.renewalId === t.renewalId &&
    r.primaryTaskId === t.taskId &&
    r.previousState === t.renewalState &&
    r.state === 'WON' &&
    r.renewalVersion === t.renewalVersion + 1 &&
    r.taskVersion === t.taskVersion + 1 &&
    canonical(r.closedAt) &&
    (a.create ? r.createdPolicyId === p.id : r.createdPolicyId === null) &&
    r.acceptedQuoteVersionId === (a.quote?.version.id ?? null) &&
    r.acceptedPolicyId === (a.quote ? p.id : null) &&
    Array.isArray(r.newPolicyIds) &&
    r.newPolicyIds.length === 1 &&
    r.newPolicyIds[0] === p.id &&
    Array.isArray(r.linkIds) &&
    r.linkIds.length === 1 &&
    typeof r.linkIds[0] === 'string' &&
    !!r.linkIds[0] &&
    Array.isArray(r.links) &&
    r.links.length === 1 &&
    r.links[0]?.id === r.linkIds[0] &&
    r.links[0].newPolicyId === p.id &&
    r.links[0].allocatedNewPremiumMinor === p.grossPremiumMinor &&
    r.links[0].currency === p.currency &&
    r.links[0].differentPolicyholderReasonCode === null
  );
}
async function history(t: TodayTaskDto, signal: AbortSignal) {
  const d = await readCustomerResource<{ quotes: Quote[] }>(
    `/api/renewals/${encodeURIComponent(t.renewalId)}/quotes`,
    signal,
  );
  if (!Array.isArray(d.quotes) || new Set(d.quotes.map((q) => q.id)).size !== d.quotes.length)
    throw Error('INVALID_QUOTES');
  return d.quotes;
}
async function renewal(a: Attempt, signal: AbortSignal) {
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const d: {
      items: { id: string; state: string; version: number }[];
      nextCursor: string | null;
    } = await readCustomerResource(
      `/api/customers/${encodeURIComponent(a.target.customerId)}/renewals?limit=50${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      signal,
    );
    if (!Array.isArray(d.items) || !(d.nextCursor === null || typeof d.nextCursor === 'string'))
      throw Error('INVALID_READBACK');
    const hits = d.items.filter((r) => r.id === a.target.renewalId);
    if (hits.length > 1) throw Error('DUPLICATE');
    if (hits.length === 1) return hits[0]!;
    if (!d.nextCursor) break;
    if (
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(d.nextCursor) ||
      seen.has(d.nextCursor) ||
      d.items.at(-1)?.id !== d.nextCursor
    )
      throw Error('INVALID_CURSOR');
    seen.add(d.nextCursor);
    cursor = d.nextCursor;
  }
  throw Error('BOUND');
}
export function WonPolicyOperation(props: Props) {
  const creating = props.mode === 'CREATE_POLICY';
  const [formBusy, setFormBusy] = useState(false),
    [lastCreate, setLastCreate] = useState<CreateReview | null>(null),
    [createComparison, setCreateComparison] = useState<TodayTaskDto | null>(null);
  const [target, setTarget] = useState<TodayTaskDto | null>(null),
    [original, setOriginal] = useState<PolicyDetailDto | null>(null),
    [policy, setPolicy] = useState<PolicyDetailDto | null>(null),
    [items, setItems] = useState<PolicyListResponseData['items']>([]),
    [search, setSearch] = useState(''),
    [appliedSearch, setAppliedSearch] = useState(''),
    [cursor, setCursor] = useState<string | null>(null),
    [failedList, setFailedList] = useState<{ cursor: string | null; search: string } | null>(null),
    [quotes, setQuotes] = useState<Quote[] | null>(null),
    [quote, setQuote] = useState<SelectedQuote | null>(null),
    [reason, setReason] = useState(''),
    [allocation, setAllocation] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Attempt | null>(null),
    [accepted, setAccepted] = useState<{ attempt: Attempt; result: WonResult | null } | null>(null),
    [conflict, setConflict] = useState(false),
    [comparison, setComparison] = useState<{ task: TodayTaskDto; policy: PolicyDetailDto } | null>(
      null,
    ),
    [masked, setMasked] = useState(false),
    [error, setError] = useState('');
  const lock = useRef(false),
    epoch = useRef(0),
    controllers = useRef(new Set<AbortController>()),
    heading = useRef<HTMLHeadingElement>(null);
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
  const unresolved = busy || formBusy || !!pending || !!accepted;
  useEffect(
    () => props.onRisk({ dirty: !!target, unresolved }),
    [target, unresolved, props.onRisk],
  );
  const alive = (e: number, c: AbortController) => e === epoch.current && !c.signal.aborted;
  async function job(work: (e: number, c: AbortController) => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const e = epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    try {
      await work(e, c);
    } finally {
      controllers.current.delete(c);
      lock.current = false;
      if (e === epoch.current) setBusy(false);
    }
  }
  function fail(cause: unknown) {
    if (cause instanceof CustomerReadError && [401, 403, 404].includes(cause.status))
      setMasked(true);
    setError('Yetkili okuma doğrulanamadı. Taslak korunur; korunan seçimleri yeniden doğrulayın.');
  }
  async function list(
    t: TodayTaskDto,
    c: AbortController,
    e: number,
    s: string,
    next: string | null,
  ) {
    const query = new URLSearchParams({
      customerId: t.customerId,
      status: 'ACTIVE',
      pageSize: '25',
      sort: 'end_date_desc',
    });
    if (s) {
      query.set('search', s);
      query.set('searchMode', 'prefix');
    }
    if (next) query.set('cursor', next);
    try {
      const d = await readCustomerResource<PolicyListResponseData>(
        `/api/policies?${query}`,
        c.signal,
      );
      if (!alive(e, c)) return;
      if (
        !Array.isArray(d.items) ||
        !(d.nextCursor === null || typeof d.nextCursor === 'string') ||
        d.items.some((p) => p.customerId !== t.customerId)
      )
        throw Error('INVALID_LIST');
      setItems((prev) =>
        next ? [...prev, ...d.items.filter((p) => !prev.some((v) => v.id === p.id))] : d.items,
      );
      setCursor(d.nextCursor);
      setFailedList(null);
    } catch (cause) {
      if (alive(e, c)) {
        setFailedList({ cursor: next, search: s });
        if (!next) {
          setItems([]);
          setCursor(null);
        }
        fail(cause);
      }
    }
  }
  async function start() {
    if (target || lock.current || props.blocked() || !props.canOperate() || !open(props.task))
      return;
    const t = { ...props.task };
    setTarget(t);
    setError('');
    if (creating) return;
    await job(async (e, c) => {
      try {
        const p = await readCustomerResource<PolicyDetailDto>(
          `/api/policies/${encodeURIComponent(t.policyId ?? '')}`,
          c.signal,
        );
        if (!alive(e, c)) return;
        if (!validPolicy(p, t.policyId ?? '', t.customerId)) throw Error('INVALID_ORIGINAL');
        setOriginal(p);
        await list(t, c, e, '', null);
      } catch (cause) {
        if (alive(e, c)) fail(cause);
      }
    });
  }
  async function select(id: string) {
    if (!target || !original || lock.current || pending || accepted || conflict) return;
    setPolicy(null);
    setQuote(null);
    setReason('');
    setAllocation(false);
    setConfirmed(false);
    setError('');
    if (!id) return;
    await job(async (e, c) => {
      try {
        const p = await readCustomerResource<PolicyDetailDto>(
          `/api/policies/${encodeURIComponent(id)}`,
          c.signal,
        );
        if (!alive(e, c)) return;
        if (id === target.policyId || !validPolicy(p, id, target.customerId, original.agencyId))
          throw Error('INVALID_POLICY');
        setPolicy(structuredClone(p));
      } catch (cause) {
        if (alive(e, c)) {
          fail(cause);
          setError(
            'Seçilen poliçe uygun veya yetkili değil. Aynı müşterinin aktif, arşivlenmemiş yeni dönem poliçesini ayrıca seçin.',
          );
        }
      }
    });
  }
  async function loadQuotes() {
    if (!target || lock.current || pending || accepted || conflict) return;
    setConfirmed(false);
    setQuote(null);
    setReason('');
    setQuotes(null);
    await job(async (e, c) => {
      try {
        const rows = await history(target, c.signal);
        if (alive(e, c)) {
          setQuotes(rows);
          setError('');
        }
      } catch (cause) {
        if (alive(e, c)) fail(cause);
      }
    });
  }
  async function verify(
    saved: { attempt: Attempt; result: WonResult | null },
    e: number,
    c: AbortController,
  ) {
    try {
      const a = saved.attempt,
        r = saved.result,
        row = await renewal(a, c.signal);
      const policyId = a.create ? r?.createdPolicyId : a.policy?.id;
      if (!policyId) throw Error('UNVERIFIED');
      const p = await readCustomerResource<PolicyDetailDto>(
        `/api/policies/${encodeURIComponent(policyId)}`,
        c.signal,
      );
      let quoteVerified = true;
      if (a.quote) {
        const rows = await history(a.target, c.signal),
          q = rows.find((q) => q.id === a.quote!.quoteId);
        quoteVerified =
          !!q &&
          q.status === 'ACCEPTED' &&
          q.accepted_version_id === a.quote.version.id &&
          q.accepted_policy_id === a.policy!.id &&
          q.versions.some(
            (v) =>
              v.id === a.quote!.version.id &&
              JSON.stringify(v) === JSON.stringify(a.quote!.version),
          ) &&
          q.events.some(
            (ev) =>
              ev.event === 'ACCEPTED' &&
              ev.quote_version_id === a.quote!.version.id &&
              ev.accepted_policy_id === a.policy!.id &&
              canonical(ev.occurred_at) &&
              ev.occurred_at === r?.closedAt,
          );
      }
      if (!alive(e, c)) return;
      if (
        !r ||
        row.state !== 'WON' ||
        row.version !== r.renewalVersion ||
        !(a.create
          ? createdPolicyMatches(p, policyId, a.create)
          : !!a.policy &&
            validPolicy(p, a.policy.id, a.target.customerId, a.policy.agencyId) &&
            samePolicy(p, a.policy)) ||
        !quoteVerified
      )
        throw Error('UNVERIFIED');
      setAccepted(null);
      setTarget(null);
      setPolicy(null);
      setQuote(null);
      setOriginal(null);
      setConfirmed(false);
      props.onApplied(
        'Yenileme kazanıldı olarak kaydedildi; poliçe ve yenileme kontrol edildi. ' +
          (a.quote ? 'Seçili teklif kabul edildi. ' : 'Teklif kabulü kaydedilmedi. ') +
          (a.create
            ? 'Yeni aktif poliçe oluşturuldu. '
            : 'Mevcut poliçe bağlandı; yeni poliçe oluşturulmadı. ') +
          'Birincil takibin kapatıldığı sunucu tarafından bildirildi.',
      );
    } catch (cause) {
      if (alive(e, c)) {
        if (cause instanceof CustomerReadError && [401, 403, 404].includes(cause.status))
          setMasked(true);
        setError(
          'Kayıt kabul edildi; poliçe veya yenilemenin sonucu henüz doğrulanamadı. Başarı henüz doğrulanmadı. Yalnız sonucu kontrol edin; ikinci kayıt gönderilmeyecek.',
        );
      }
    }
  }
  async function transmit(a: Attempt) {
    if (lock.current || accepted || props.blocked() || !props.canOperate()) return;
    setPending(a);
    setError('');
    await job(async (e, c) => {
      try {
        const csrf = await getCsrfToken();
        if (!alive(e, c)) return;
        const r = await fetch(a.url, {
          method: a.method,
          body: a.body,
          signal: c.signal,
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf,
            'idempotency-key': a.key,
          },
        });
        const d = (await r.json().catch(() => null)) as
          (ApiResponse<unknown> & { replayed?: boolean }) | null;
        if (!alive(e, c)) return;
        if (!r.ok) {
          if (r.status >= 500 || [408, 429].includes(r.status)) throw Error('UNCERTAIN');
          if (r.status === 403) invalidateCsrfToken();
          setPending(null);
          setConfirmed(false);
          setAllocation(false);
          setConflict(true);
          setComparison(null);
          if ([401, 403, 404].includes(r.status)) setMasked(true);
          if (r.status === 401) {
            parseAppError(401);
            return;
          }
          setError(
            r.status === 409
              ? creating
                ? 'Kazanıldı kaydı çakıştı. Aynı poliçe numarası zaten kayıtlı olabilir veya özgün takip veya kayıt sürümleri değişmiştir. Oluşturma taslağı korunur; numara otomatik değiştirilmez ve mevcut poliçeyi bağlama seçeneğine geçilmez. Yetkili karşılaştırıp taslağı yeniden inceleyin.'
                : 'Kazanıldı kaydı çakıştı. Poliçe önceden tahsis edilmiş, hedef veya sürüm değişmiş ya da teklif süresi dolmuş olabilir. Tam primin tamamı dışında tahsis desteklenmez. Taslak korunur; yetkili karşılaştırma, açık yeniden seçim ve onay gerekir.'
              : 'Kazanıldı işlemi için yetki veya seçili kayıt doğrulanamadı. Korunan ayrıntılar gizlendi; yetkili karşılaştırma gerekir.',
          );
          return;
        }
        const saved = {
          attempt: a,
          result:
            d?.success &&
            (!a.create || r.status === 201 || (r.status === 200 && d.replayed === true)) &&
            proof(d.data, a)
              ? d.data
              : null,
        };
        setPending(null);
        setAccepted(saved);
        await verify(saved, e, c);
      } catch {
        if (alive(e, c))
          setError(
            'Sonuç belirsiz. Özgün Task, poliçe, sürümler, URL, body ve anahtar korunur; yalnız aynı istek tekrar edilir.',
          );
      }
    });
  }
  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const submissionEpoch = epoch.current;
    if (
      !target ||
      !policy ||
      !original ||
      lock.current ||
      pending ||
      accepted ||
      conflict ||
      masked ||
      props.blocked() ||
      !props.canOperate()
    )
      return;
    if (!allocation || !confirmed) {
      setError('Primin tamamının tahsisini ve kazanıldı son onayını ayrı ayrı doğrulayın.');
      return;
    }
    if (
      !validPolicy(policy, policy.id, target.customerId, original.agencyId) ||
      policy.id === target.policyId
    )
      return;
    const diff = quote ? differences(policy, quote) : [];
    if (
      quote &&
      (!canonical(quote.version.valid_until) || Date.parse(quote.version.valid_until) <= Date.now())
    ) {
      setConfirmed(false);
      setError('Seçili teklifin süresi doldu. Yetkili teklifleri yeniden okuyup açıkça seçin.');
      return;
    }
    if (diff.length && !/^[A-Z][A-Z0-9_]{2,63}$/.test(reason)) {
      setError(
        'Fark için sizin belirlediğiniz 3–64 karakter A-Z, 0-9 ve alt çizgi içeren neden kodunu girin.',
      );
      return;
    }
    if (quote) {
      let ok = false;
      await job(async (e, c) => {
        try {
          const rows = await history(target, c.signal),
            fresh = rows.find((q) => q.id === quote.quoteId),
            chosen = fresh ? eligible(fresh) : null;
          if (!alive(e, c)) return;
          ok =
            !!chosen &&
            chosen.quoteCas === quote.quoteCas &&
            JSON.stringify(chosen.version) === JSON.stringify(quote.version);
          if (!ok) {
            setConfirmed(false);
            setError(
              'Seçili teklif artık aynı geçerli SENT sürümü değil. Açık yeniden okuma ve seçim gerekir.',
            );
          }
        } catch (cause) {
          if (alive(e, c)) fail(cause);
        }
      });
      if (!ok || submissionEpoch !== epoch.current) return;
    }
    void transmit({
      target: structuredClone(target),
      policy: structuredClone(policy),
      quote: quote ? structuredClone(quote) : null,
      url: `/api/renewals/${encodeURIComponent(target.renewalId)}/close-won`,
      method: 'POST',
      key: crypto.randomUUID(),
      body: JSON.stringify({
        expectedPrimaryTaskId: target.taskId,
        expectedRenewalVersion: target.renewalVersion,
        expectedTaskVersion: target.taskVersion,
        result: {
          kind: 'LINK_POLICY',
          newPolicyId: policy.id,
          expectedPolicyVersion: policy.version,
          allocatedNewPremiumMinor: policy.grossPremiumMinor,
          currency: policy.currency,
        },
        ...(quote
          ? {
              acceptedQuoteVersionId: quote.version.id,
              ...(diff.length ? { quoteDifferenceReasonCode: reason } : {}),
            }
          : {}),
      }),
    });
  }
  async function compare() {
    if (
      !target ||
      !policy ||
      lock.current ||
      pending ||
      accepted ||
      props.blocked() ||
      !props.canOperate()
    )
      return;
    setConfirmed(false);
    setAllocation(false);
    setComparison(null);
    await job(async (e, c) => {
      try {
        const fresh = await props.read(c.signal),
          p = await readCustomerResource<PolicyDetailDto>(
            `/api/policies/${encodeURIComponent(policy.id)}`,
            c.signal,
          );
        if (!alive(e, c)) return;
        if (
          !fresh.current ||
          !sameTask(target, fresh.current) ||
          !open(fresh.current) ||
          !validPolicy(p, policy.id, target.customerId, original?.agencyId)
        ) {
          setError(
            'Özgün Task veya poliçe artık uygun değil. Başka primary Task benimsenmedi; taslağı açıkça kapatıp bağımsız seçim yapın.',
          );
          return;
        }
        setMasked(false);
        setComparison({ task: { ...fresh.current }, policy: p });
        setError(
          'Eski ve güncel sürümleri karşılaştırın. Yeni işlem için aynı Task açıkça benimsenmeli, poliçe ve varsa teklif yeniden seçilmelidir.',
        );
      } catch (cause) {
        if (alive(e, c)) fail(cause);
      }
    });
  }
  function reset() {
    if (unresolved) return;
    epoch.current++;
    setTarget(null);
    setOriginal(null);
    setPolicy(null);
    setQuote(null);
    setQuotes(null);
    setItems([]);
    setSearch('');
    setAppliedSearch('');
    setCursor(null);
    setFailedList(null);
    setReason('');
    setConfirmed(false);
    setAllocation(false);
    setConflict(false);
    setComparison(null);
    setMasked(false);
    setError('');
    setLastCreate(null);
    setCreateComparison(null);
    setFormBusy(false);
  }
  const diff = policy && quote ? differences(policy, quote) : [];
  async function compareCreate() {
    if (
      !target ||
      !lastCreate ||
      lock.current ||
      pending ||
      accepted ||
      props.blocked() ||
      !props.canOperate()
    )
      return;
    setCreateComparison(null);
    await job(async (e, c) => {
      try {
        const fresh = await props.read(c.signal);
        const query = new URLSearchParams({
          customerId: target.customerId,
          search: lastCreate.policy.policyNumber,
          searchMode: 'exact',
          pageSize: '25',
          status: 'ACTIVE',
        });
        const listed = await readCustomerResource<PolicyListResponseData>(
          '/api/policies?' + query,
          c.signal,
        );
        if (!alive(e, c)) return;
        if (
          !fresh.current ||
          !sameTask(target, fresh.current) ||
          !open(fresh.current) ||
          !Array.isArray(listed.items) ||
          listed.items.some((p) => p.customerId !== target.customerId)
        ) {
          setError(
            'Özgün Task artık uygun değil; replacement Task benimsenmedi. Eski taslağı açıkça kapatıp yeni görevi ayrıca seçin.',
          );
          return;
        }
        setMasked(false);
        setCreateComparison(fresh.current);
        setError(
          `Yetkili aynı-numara poliçe aramasında ${listed.items.length} kayıt bu sayfada bulundu. Otomatik LINK_POLICY veya numara değişikliği yapılmaz; taslağı kontrol edip açıkça yeniden inceleyin.`,
        );
      } catch (cause) {
        if (alive(e, c)) fail(cause);
      }
    });
  }
  if (creating)
    return (
      <>
        <Button
          variant="outline"
          disabled={!!target || unresolved || props.blocked()}
          onClick={() => void start()}
        >
          Kazanıldı — yeni poliçe oluştur
        </Button>
        {target && (
          <section aria-label="WON yeni poliçe oluşturma" className="today-outcome-form">
            <h4 ref={heading} tabIndex={-1}>
              Kazanıldı — yeni poliçe oluştur
            </h4>
            {!masked && (
              <details>
                <summary>Destek ayrıntıları</summary>
                <p>
                  Müşteri: {target.customerDisplayName}; eski poliçe {target.policyNumber}; yenileme{' '}
                  {target.renewalId}; Task {target.taskId}; yenileme/görev CAS{' '}
                  {target.renewalVersion}/{target.taskVersion}.
                </p>
              </details>
            )}
            <WonCreatePolicyForm
              task={target}
              masked={masked}
              disabled={busy || !!pending || !!accepted || conflict}
              onBusy={setFormBusy}
              onSubmit={(review) => {
                if (
                  lock.current ||
                  pending ||
                  accepted ||
                  conflict ||
                  masked ||
                  props.blocked() ||
                  !props.canOperate()
                )
                  return;
                setLastCreate(structuredClone(review));
                void transmit({
                  target: structuredClone(target),
                  policy: null,
                  create: structuredClone(review),
                  quote: null,
                  url: `/api/renewals/${encodeURIComponent(target.renewalId)}/close-won`,
                  method: 'POST',
                  key: crypto.randomUUID(),
                  body: JSON.stringify({
                    expectedPrimaryTaskId: target.taskId,
                    expectedRenewalVersion: target.renewalVersion,
                    expectedTaskVersion: target.taskVersion,
                    result: { kind: 'CREATE_POLICY', policy: review.policy },
                  }),
                });
              }}
            />
            {masked && <p>Yetkili bağlam doğrulanamadı; korunan oluşturma taslağı gizlendi.</p>}
            {error && <p role="alert">{error}</p>}
            {pending && (
              <Button disabled={busy} onClick={() => void transmit(pending)}>
                Aynı poliçe oluşturma isteğini yeniden dene
              </Button>
            )}
            {accepted && (
              <Button disabled={busy} onClick={() => void job((e, c) => verify(accepted, e, c))}>
                Yalnız oluşturulan poliçe okumalarını yeniden dene
              </Button>
            )}
            {conflict && !pending && !accepted && (
              <Button disabled={unresolved} onClick={() => void compareCreate()}>
                Poliçe oluşturma bilgilerini karşılaştır
              </Button>
            )}
            {createComparison && !masked && (
              <>
                <p>
                  Aynı Task {createComparison.taskId}; eski/güncel CAS {target.renewalVersion}/
                  {target.taskVersion} → {createComparison.renewalVersion}/
                  {createComparison.taskVersion}.
                </p>
                <Button
                  disabled={unresolved}
                  onClick={() => {
                    setTarget({ ...createComparison });
                    setCreateComparison(null);
                    setConflict(false);
                    setError(
                      'Aynı takip açıkça benimsendi. Korunan poliçe taslağını yeniden inceleyip ayrı onay verin.',
                    );
                  }}
                >
                  Aynı takip ile oluşturma taslağını yeniden incele
                </Button>
              </>
            )}
            <Button variant="outline" disabled={unresolved} onClick={reset}>
              Yeni poliçeyle kazanma taslağını açıkça kapat
            </Button>
          </section>
        )}
      </>
    );
  return (
    <>
      <Button
        variant="outline"
        disabled={!!target || unresolved || props.blocked()}
        onClick={() => void start()}
      >
        Kazanıldı — mevcut poliçeyi bağla
      </Button>
      {target && (
        <form
          aria-label="WON mevcut poliçe bağlama"
          className="today-outcome-form"
          onSubmit={(e) => void submit(e)}
        >
          <h4 ref={heading} tabIndex={-1}>
            Kazanıldı — mevcut yeni dönem poliçesi
          </h4>
          <p>
            Bu işlem yeni poliçe oluşturmaz. Seçtiğiniz mevcut poliçeye izin verilen ilişkiyi kurar,
            yenilemeyi kazanıldı olarak kapatır ve seçili birincil takibi tamamlar. Yerine görev
            oluşturmaz.
          </p>
          {!masked && (
            <>
              <p>
                Müşteri: {target.customerDisplayName} — Eski poliçe: {target.policyNumber}. Sabit
                yenileme: {target.renewalId}; Task: {target.taskId}. Yenileme sürümü:{' '}
                {target.renewalVersion}; Görev sürümü: {target.taskVersion}.
              </p>
              <fieldset disabled={unresolved || conflict}>
                <legend>Mevcut poliçeyi seç ve doğrula</legend>
                <label>
                  Poliçe numarasıyla ara
                  <input
                    value={search}
                    maxLength={100}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.preventDefault();
                    }}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setConfirmed(false);
                    }}
                  />
                </label>
                <Button
                  type="button"
                  disabled={!original}
                  onClick={() => {
                    setPolicy(null);
                    setQuote(null);
                    setReason('');
                    setConfirmed(false);
                    setAllocation(false);
                    setAppliedSearch(search.trim());
                    setError('');
                    void job((e, c) => list(target, c, e, search.trim(), null));
                  }}
                >
                  Poliçeleri ara
                </Button>
                <label>
                  Bağlanacak mevcut poliçe
                  <select
                    value={policy?.id ?? ''}
                    disabled={!original}
                    onChange={(e) => void select(e.target.value)}
                  >
                    <option value="">Poliçe seçin</option>
                    {items.map((p) => (
                      <option key={p.id} value={p.id} disabled={p.id === target.policyId}>
                        {p.policyNumber} — {p.endDate}
                      </option>
                    ))}
                  </select>
                </label>
                {cursor && (
                  <Button
                    type="button"
                    onClick={() => void job((e, c) => list(target, c, e, appliedSearch, cursor))}
                  >
                    Daha fazla poliçe
                  </Button>
                )}
                {failedList && (
                  <Button
                    type="button"
                    onClick={() =>
                      void job((e, c) => list(target, c, e, failedList.search, failedList.cursor))
                    }
                  >
                    Poliçe listesini yeniden dene
                  </Button>
                )}
                {policy && (
                  <>
                    <p>
                      Yeni poliçe: {policy.policyNumber} — {policy.insurer.name} /{' '}
                      {policy.product.name}; {policy.startDate} → {policy.endDate}. Brüt prim:{' '}
                      {completionMoney(policy.grossPremiumMinor, policy.currency)}. Poliçe sürümü:{' '}
                      {policy.version}.
                    </p>
                    <p>
                      Bu poliçenin önceki tahsis toplamı burada gösterilmiyor. Burada yalnız primin
                      tamamı ({completionMoney(policy.grossPremiumMinor, policy.currency)}) tahsis
                      edilir. Önceki tahsis varsa kayıt reddedilir; kısmi/paylaşımlı tahsis
                      desteklenmez.
                    </p>
                    <Button type="button" onClick={() => void loadQuotes()}>
                      İsteğe bağlı gönderildi kayıtlı teklifleri oku
                    </Button>
                    {quotes && (
                      <label>
                        İsteğe bağlı kabul edilecek teklif
                        <select
                          value={quote?.version.id ?? ''}
                          onChange={(e) => {
                            const q = quotes.find((q) => q.current_version_id === e.target.value);
                            setQuote(q ? eligible(q) : null);
                            setReason('');
                            setConfirmed(false);
                          }}
                        >
                          <option value="">Teklif ilişkilendirme yok</option>
                          {quotes.map((q) => {
                            const v = eligible(q);
                            return v ? (
                              <option key={q.id} value={v.version.id}>
                                {q.id} / v{v.version.version_number} —{' '}
                                {completionMoney(v.version.gross_premium_minor, v.version.currency)}
                              </option>
                            ) : null;
                          })}
                        </select>
                      </label>
                    )}
                    {quote ? (
                      <>
                        <p>
                          Seçili gönderildi kayıtlı teklif sürümü: {quote.version.id}; ürün:{' '}
                          {quote.version.product_id}; prim:{' '}
                          {completionMoney(
                            quote.version.gross_premium_minor,
                            quote.version.currency,
                          )}
                          ; geçerlilik: {quote.version.valid_until}. Gönderildi kaydı gerçek mesaj
                          teslimi kanıtı değildir.
                        </p>
                        {diff.length > 0 && (
                          <>
                            <p>Teklif/poliçe farkı: {diff.join(' · ')}</p>
                            <label>
                              Teklif farkı neden kodu
                              <input
                                value={reason}
                                maxLength={64}
                                onChange={(e) => {
                                  setReason(e.target.value);
                                  setConfirmed(false);
                                }}
                              />
                            </label>
                            <p>
                              Nedeni siz belirleyin; 3–64 karakter, büyük harf/rakam/alt çizgi.
                              Otomatik genel neden gönderilmez.
                            </p>
                          </>
                        )}
                      </>
                    ) : (
                      <p>
                        Teklif seçilmedi; kazanıldı sonucu hiçbir teklifin kabul edildiği anlamına
                        gelmez.
                      </p>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={allocation}
                        onChange={(e) => {
                          setAllocation(e.target.checked);
                          setConfirmed(false);
                        }}
                      />
                      Seçilen poliçenin priminin tamamını bu yenilemeye tahsis ediyorum
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(e) => setConfirmed(e.target.checked)}
                      />
                      Kazanıldı sonucunu ve seçtiğim kayıtları onaylıyorum
                    </label>
                    <Button type="submit">Yenilemeyi kazanıldı olarak kaydet</Button>
                  </>
                )}
              </fieldset>
            </>
          )}
          {masked && (
            <p>
              Yetkili bağlam doğrulanamadı; korunan hedef ve poliçe/teklif ayrıntıları gizlendi.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {busy && <p role="status">Kazanıldı işlemi veya sonuç kontrolü sürüyor…</p>}
          {conflict && !pending && !accepted && (
            <Button type="button" disabled={busy} onClick={() => void compare()}>
              Kazanılacak yenilemenin kayıtlarını karşılaştır
            </Button>
          )}
          {comparison && !masked && (
            <>
              <p>
                Task aynı: {comparison.task.taskId}. Eski/güncel yenileme: {target.renewalVersion}/
                {comparison.task.renewalVersion}; görev: {target.taskVersion}/
                {comparison.task.taskVersion}; poliçe: {policy?.version}/{comparison.policy.version}
                .
              </p>
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  setTarget(comparison.task);
                  setComparison(null);
                  setPolicy(null);
                  setQuote(null);
                  setQuotes(null);
                  setReason('');
                  setConfirmed(false);
                  setAllocation(false);
                  setConflict(false);
                  setError(
                    'Aynı takip açıkça benimsendi. Poliçeyi ve teklifi yeniden seçip tüm onayları verin.',
                  );
                }}
              >
                Aynı Task ile poliçeyi yeniden seç
              </Button>
            </>
          )}
          {pending && (
            <Button type="button" disabled={busy} onClick={() => void transmit(pending)}>
              Aynı kazanıldı isteğini yeniden dene
            </Button>
          )}
          {accepted && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => void job((e, c) => verify(accepted, e, c))}
            >
              Yalnız kazanıldı sonucunu kontrol et
            </Button>
          )}
          <Button type="button" variant="outline" disabled={unresolved} onClick={reset}>
            Kazanıldı taslağını açıkça kapat
          </Button>
        </form>
      )}
    </>
  );
}

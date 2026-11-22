import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { ApiResponse, InsuranceBranchDto, TodayTaskDto } from '../../../shared/types';
import {
  salesResultSchema,
  type SalesCaseDto,
  type SalesCommandResult,
} from '../../../shared/sales';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { PageHeader } from '../../components/layout/PageContainer';
import { CustomerNumberGuard } from '../customers/CustomerNumberGuard';
import { readCustomerResource, useCustomerResource } from '../customers/customer-resource';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { canonicalOccurrence } from '../today-work/interaction-model';
import { ReturnToWork } from '../today-work/work-navigation';
import { SalesPricesSection, type PriceRisk } from './SalesPricesSection';
import { SalesLossSection } from './SalesLossSection';
import { SalesIssueSection } from './SalesIssueSection';
import { SalesCaseCorrectionSection } from './SalesCaseCorrectionSection';
import { SalesWonCorrectionSection } from './SalesWonCorrectionSection';
type Page = { items: SalesCaseDto[]; hasMore: boolean; nextCursor: string | null };
type Task = { taskId: string; taskVersion: number; dueAt: string; assigneeMembershipId: string };
type Attempt = { url: string; body: string; key: string; result?: SalesCommandResult };
const cycleLabel = (value: string) =>
  new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'medium' }).format(
    new Date(value + 'T12:00:00Z'),
  );
function useWrite(onVerified: (r: SalesCommandResult) => Promise<void>) {
  const [pending, setPending] = useState<Attempt | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [code, setCode] = useState('');
  const saving = useRef(false),
    live = useRef(true),
    latest = useRef(onVerified);
  latest.current = onVerified;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function send(a: Attempt) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setCode('');
    try {
      let accepted = a;
      if (!a.result) {
        const csrf = await getCsrfToken();
        const response = await fetch(a.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf,
            'idempotency-key': a.key,
          },
          body: a.body,
        });
        if (!live.current) return;
        const data = (await response.json()) as ApiResponse<unknown>;
        if (!response.ok || !data.success) {
          if (response.status === 401) {
            invalidateCsrfToken();
            document.dispatchEvent(new Event('mayi-session-ended'));
          }
          if (response.status === 403) invalidateCsrfToken();
          const failure = !data.success
            ? data.error
            : { code: 'UNKNOWN', message: 'Kayıt doğrulanamadı.' };
          setCode(failure.code);
          if (
            [400, 413, 415].includes(response.status) ||
            (response.status === 409 && failure.code !== 'IDEMPOTENCY_CONFLICT')
          )
            setPending(null);
          throw Error(failure.message);
        }
        accepted = { ...a, result: salesResultSchema.parse(data.data) };
        const command = JSON.parse(a.body) as {
          context?: string;
          expectedPrimaryTaskId?: string;
          expectedPrimaryTaskVersion?: number;
          followup?: { dueAt: string };
          dueAt?: string;
          expectedCaseVersion?: number;
          expectedTaskVersion?: number;
          expectedTaskId?: string;
        };
        if (
          command.context === 'RENEWAL'
            ? accepted.result!.caseVersion !== 1 ||
              accepted.result!.taskId !== command.expectedPrimaryTaskId ||
              accepted.result!.taskVersion !== command.expectedPrimaryTaskVersion
            : accepted.result!.dueAt !== (command.followup?.dueAt ?? command.dueAt) ||
              accepted.result!.caseVersion !== (command.expectedCaseVersion ?? 0) + 1 ||
              accepted.result!.taskVersion !== (command.expectedTaskVersion ?? 0) + 1 ||
              (command.expectedTaskId && accepted.result!.taskId !== command.expectedTaskId)
        )
          throw Error('İşlem yanıtı gönderilen takiple eşleşmedi.');
        setPending(accepted);
      }
      const r = accepted.result!;
      const proof = await readCustomerResource<SalesCommandResult>(
        `/api/sales-cases/${encodeURIComponent(r.caseId)}/operations/${encodeURIComponent(r.operationId)}`,
      );
      if (
        JSON.stringify(salesResultSchema.parse(proof)) !==
        JSON.stringify(salesResultSchema.parse(r))
      )
        throw Error('Kayıtlı işlem yanıtı eşleşmedi.');
      await latest.current(r);
      if (live.current) setPending(null);
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : 'Kayıt doğrulanamadı.');
    } finally {
      saving.current = false;
      if (live.current) setBusy(false);
    }
  }
  return {
    pending,
    busy,
    error,
    code,
    locked: busy || !!pending,
    start(url: string, body: unknown) {
      if (pending || saving.current) return;
      const a = { url, body: JSON.stringify(body), key: crypto.randomUUID() };
      setPending(a);
      void send(a);
    },
    retry() {
      if (pending) void send(pending);
    },
  };
}
function WriteNotice({ state }: { state: ReturnType<typeof useWrite> }) {
  return (
    <>
      {state.error && (
        <p role="alert" className="customer-error">
          {state.error}
        </p>
      )}
      {state.busy && <p role="status">Kaydedilen bilgiler kontrol ediliyor…</p>}
      {state.pending && (
        <div className="policy-lifecycle-summary">
          <p>Sonuç doğrulanana kadar bilgiler korunuyor.</p>
          <Button disabled={state.busy} onClick={state.retry}>
            {state.pending.result ? 'Kayıtlı sonucu doğrula' : 'Aynı işlemi tekrar kontrol et'}
          </Button>
        </div>
      )}
    </>
  );
}
/** Admission reuses the selected real renewal Task; the renewal workspace owns all later actions. */
export function RenewalSalesCaseAction({
  task,
  canOperate,
  onRisk,
  onOpened,
}: {
  task: Pick<
    TodayTaskDto,
    'renewalId' | 'renewalVersion' | 'taskId' | 'taskVersion' | 'customerId' | 'dueAt'
  >;
  canOperate: () => boolean;
  onRisk: (risk: { dirty: boolean; unresolved: boolean }) => void;
  onOpened?: (caseId: string) => void;
}) {
  const [checking, setChecking] = useState(false),
    [readError, setReadError] = useState(''),
    [saved, setSaved] = useState<string | null>(null);
  const reading = useRef(false);
  const state = useWrite(async (r) => {
    const fresh = await readCustomerResource<SalesCaseDto>(
      `/api/sales-cases/${encodeURIComponent(r.caseId)}`,
    );
    if (
      fresh.context !== 'RENEWAL' ||
      fresh.renewalId !== task.renewalId ||
      fresh.customerId !== task.customerId ||
      r.dueAt !== task.dueAt
    )
      throw Error('Yenileme çalışması doğrulanamadı.');
    setSaved(r.caseId);
    onOpened?.(r.caseId);
  });
  useEffect(() => {
    onRisk({ dirty: false, unresolved: checking || state.locked });
  }, [checking, state.locked, onRisk]);
  async function open() {
    if (reading.current || state.locked || !canOperate()) return;
    reading.current = true;
    setChecking(true);
    setReadError('');
    try {
      const page = await readCustomerResource<Page>(
        `/api/sales-cases?renewalId=${encodeURIComponent(task.renewalId)}&result=ALL&limit=1`,
      );
      if (!Array.isArray(page.items)) throw Error('Çalışma bilgisi doğrulanamadı.');
      const existing = page.items.find(
        (c) =>
          c.context === 'RENEWAL' &&
          c.renewalId === task.renewalId &&
          c.customerId === task.customerId,
      );
      if (existing) {
        setSaved(existing.id);
        onOpened?.(existing.id);
      } else
        state.start(`/api/customers/${encodeURIComponent(task.customerId)}/sales-cases`, {
          context: 'RENEWAL',
          renewalId: task.renewalId,
          expectedVersion: task.renewalVersion,
          expectedPrimaryTaskId: task.taskId,
          expectedPrimaryTaskVersion: task.taskVersion,
        });
    } catch (e) {
      setReadError(e instanceof Error ? e.message : 'Çalışma bilgisi okunamadı.');
    } finally {
      reading.current = false;
      setChecking(false);
    }
  }
  return (
    <section className="policy-lifecycle-summary" aria-label="Yenileme teklif çalışması">
      <h3>Teklif çalışması</h3>
      <p>
        Mevcut yenilemenin teklif çalışmasını açın. Takip ve poliçelendirme bu yenilemede devam
        eder.
      </p>
      {readError && <p role="alert">{readError}</p>}
      {checking && <p role="status">Mevcut çalışma kontrol ediliyor…</p>}
      <WriteNotice state={state} />
      {saved ? (
        <>
          <p role="status">Yenileme çalışması hazır.</p>
          <Button asChild variant="outline">
            <Link to={`/sales-cases/${encodeURIComponent(saved)}`}>Çalışmaya git</Link>
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          disabled={checking || state.locked || !canOperate()}
          onClick={() => void open()}
        >
          Teklif çalışmasını aç
        </Button>
      )}
    </section>
  );
}
export function SalesCasesSection({
  customer,
}: {
  customer: { id: string; displayName: string; archivedAt: string | null };
}) {
  const [cursor, setCursor] = useState<string | null>(null),
    [opened, setOpened] = useState(false),
    [branch, setBranch] = useState(''),
    [cycle, setCycle] = useState(''),
    [due, setDue] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [validation, setValidation] = useState(''),
    [saved, setSaved] = useState<string | null>(null);
  const list = useCustomerResource<Page>(
    `/api/sales-cases?customerId=${encodeURIComponent(customer.id)}&limit=20${branch ? '&branchId=' + encodeURIComponent(branch) : ''}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
  );
  const catalogs = useCustomerResource<readonly InsuranceBranchDto[]>(
    opened ? '/api/catalogs/branches' : null,
  );
  const state = useWrite(async (r) => {
    const c = await readCustomerResource<SalesCaseDto>(`/api/sales-cases/${r.caseId}`),
      t = await readCustomerResource<Task>(`/api/sales-cases/${r.caseId}/task`);
    if (
      c.customerId !== customer.id ||
      c.branchId !== branch ||
      c.version < r.caseVersion ||
      t.taskId !== r.taskId ||
      t.taskVersion < r.taskVersion
    )
      throw Error('Çalışma ve takip kaydı henüz doğrulanamadı.');
    setSaved(r.caseId);
    setOpened(false);
    setCursor(null);
    setBranch('');
    setCycle('');
    setDue('');
    setConfirmed(false);
    list.reload();
  });
  const needsConfirm =
    state.code === 'SIMILAR_OPEN_CASES' ||
    (Array.isArray(list.data?.items) && list.data.items.some((s) => s.branchId === branch));
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const when = canonicalOccurrence(due);
    if (!when) {
      setValidation('Geçerli takip zamanı seçin.');
      return;
    }
    setValidation('');
    state.start(`/api/customers/${encodeURIComponent(customer.id)}/sales-cases`, {
      context: 'NEW_BUSINESS',
      branchId: branch,
      cycleDate: cycle || null,
      dateBasis: cycle ? 'KNOWN_END_DATE' : 'MANUAL',
      followup: { dueAt: when },
      confirmSimilar: confirmed,
    });
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Teklif çalışmaları</CardTitle>
      </CardHeader>
      <CardContent>
        <CustomerNumberGuard
          protectSearch
          dirty={opened && (!!branch || !!cycle || !!due)}
          unresolved={state.locked}
          label="Teklif çalışması"
        />
        <p>Poliçe kaydı olmadan teklif görüşmesini ve sonraki aramayı takip edin.</p>
        {saved && (
          <p role="status">
            Çalışma ve takip kaydedildi. <Link to={`/sales-cases/${saved}`}>Çalışmayı aç</Link>
          </p>
        )}
        <WriteNotice state={state} />
        {!opened && !customer.archivedAt && (
          <Button
            onClick={() => {
              setOpened(true);
              setSaved(null);
            }}
          >
            Yeni teklif çalışması
          </Button>
        )}
        {opened && (
          <form
            className="customer-edit-form sales-case-form"
            aria-label="Yeni teklif çalışması"
            method="post"
            action={`/api/customers/${customer.id}/sales-cases`}
            onSubmit={submit}
          >
            {validation && <p role="alert">{validation}</p>}
            {catalogs.error && (
              <p role="alert">
                Branşlar yüklenemedi. <Button onClick={catalogs.reload}>Yeniden dene</Button>
              </p>
            )}
            <fieldset disabled={state.locked}>
              <legend>Çalışma ve takip bilgileri</legend>
              <div className="customer-form-grid">
                <div>
                  <label htmlFor="sales-branch">Branş (zorunlu)</label>
                  <select
                    id="sales-branch"
                    name="branchId"
                    required
                    value={branch}
                    onChange={(e) => {
                      setBranch(e.target.value);
                      setCursor(null);
                      setConfirmed(false);
                    }}
                  >
                    <option value="">Seçin</option>
                    {(Array.isArray(catalogs.data) ? catalogs.data : [])
                      .filter((b) => b.status === 'ACTIVE')
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="sales-cycle">Mevcut dönem sonu (biliniyorsa)</label>
                  <input
                    id="sales-cycle"
                    name="cycleDate"
                    type="date"
                    value={cycle}
                    onChange={(e) => setCycle(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="sales-due">Takip zamanı · İstanbul (zorunlu)</label>
                  <input
                    id="sales-due"
                    name="dueAt"
                    type="datetime-local"
                    required
                    value={due}
                    onChange={(e) => {
                      setDue(e.target.value);
                      setValidation('');
                    }}
                  />
                </div>
              </div>
              {due &&
                canonicalOccurrence(due) &&
                canonicalOccurrence(due)! < new Date().toISOString() && (
                  <p>Geçmiş bir takip zamanı seçtiniz; kayıt geciken işlerde görünecek.</p>
                )}
              {needsConfirm && (
                <label className="company-primary-choice">
                  <input
                    type="checkbox"
                    name="confirmSimilar"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  Açık çalışmaları inceledim; bu ayrı bir ihtiyaç.
                </label>
              )}
            </fieldset>
            <div className="customer-form-actions">
              <Button type="submit" disabled={state.locked}>
                Çalışmayı ve takibi kaydet
              </Button>
              <Button variant="outline" disabled={state.locked} onClick={() => setOpened(false)}>
                Vazgeç
              </Button>
            </div>
          </form>
        )}
        {list.loading && <p role="status">Çalışmalar yükleniyor…</p>}
        {list.error && (
          <p role="alert">
            {list.error.message}{' '}
            <Button variant="outline" onClick={list.reload}>
              Yeniden dene
            </Button>
          </p>
        )}
        {Array.isArray(list.data?.items) && (
          <div className="sales-case-list">
            {list.data.items.length === 0 ? (
              <p>Açık teklif çalışması yok.</p>
            ) : (
              list.data.items.map((c) => (
                <article className="policy-lifecycle-summary" key={c.id}>
                  <strong>
                    <Link to={`/sales-cases/${encodeURIComponent(c.id)}`}>
                      {c.branchName} ·{' '}
                      {c.context === 'RENEWAL' ? 'Yenileme çalışması' : 'Teklif çalışması'}
                    </Link>
                  </strong>
                  <p>
                    {c.cycleDate
                      ? `Dönem sonu: ${cycleLabel(c.cycleDate)}`
                      : 'Dönem sonu belirtilmedi'}
                  </p>
                </article>
              ))
            )}
          </div>
        )}
        {(cursor || list.data?.hasMore) && (
          <div className="customer-form-actions">
            <Button
              variant="outline"
              disabled={state.locked || !cursor}
              onClick={() => setCursor(null)}
            >
              İlk sayfa
            </Button>
            <Button
              variant="outline"
              disabled={state.locked || !list.data?.nextCursor}
              onClick={() => setCursor(list.data?.nextCursor ?? null)}
            >
              Sonraki sayfa
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
function SalesCase({ id }: { id: string }) {
  const summary = useCustomerResource<SalesCaseDto>(`/api/sales-cases/${encodeURIComponent(id)}`),
    task = useCustomerResource<Task>(
      summary.data?.context === 'NEW_BUSINESS' && summary.data.result === 'OPEN'
        ? `/api/sales-cases/${encodeURIComponent(id)}/task`
        : null,
    );
  const [opened, setOpened] = useState(false),
    [due, setDue] = useState(''),
    [reason, setReason] = useState('CALL_AGAIN'),
    [notes, setNotes] = useState(''),
    [message, setMessage] = useState(''),
    [validation, setValidation] = useState('');
  const [priceRisk, setPriceRisk] = useState<PriceRisk>({ dirty: false, unresolved: false });
  const [lossRisk, setLossRisk] = useState<PriceRisk>({ dirty: false, unresolved: false });
  const [issueRisk, setIssueRisk] = useState<PriceRisk>({ dirty: false, unresolved: false });
  const [correctionRisk, setCorrectionRisk] = useState<PriceRisk>({
    dirty: false,
    unresolved: false,
  });
  const [voidVerified, setVoidVerified] = useState(false);
  const [reopenedTaskId, setReopenedTaskId] = useState<string | null>(null);
  const [issuedPolicyId, setIssuedPolicyId] = useState<string | null>(null);
  const issueActive = issueRisk.dirty || issueRisk.unresolved;
  const correctionActive = correctionRisk.dirty || correctionRisk.unresolved;
  const onLossRisk = useCallback(
    (risk: PriceRisk) =>
      setLossRisk((old) =>
        old.dirty === risk.dirty && old.unresolved === risk.unresolved ? old : risk,
      ),
    [],
  );
  const onPriceRisk = useCallback(
    (risk: PriceRisk) =>
      setPriceRisk((old) =>
        old.dirty === risk.dirty && old.unresolved === risk.unresolved ? old : risk,
      ),
    [],
  );
  const state = useWrite(async (r) => {
    if (r.caseId !== id) throw Error('Yanıt çalışma ile eşleşmedi.');
    const fresh = await readCustomerResource<Task>(`/api/sales-cases/${id}/task`);
    if (fresh.taskId !== r.taskId || fresh.taskVersion < r.taskVersion)
      throw Error('Takip zamanı doğrulanamadı.');
    task.reload();
    summary.reload();
    setOpened(false);
    setDue('');
    setNotes('');
    setMessage('Takip zamanı güncellendi.');
  });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const when = canonicalOccurrence(due);
    if (!when || !summary.data || !task.data) {
      setValidation('Geçerli takip zamanı seçin.');
      return;
    }
    setValidation('');
    state.start(`/api/sales-cases/${id}/followup`, {
      expectedCaseVersion: summary.data.version,
      expectedTaskId: task.data.taskId,
      expectedTaskVersion: task.data.taskVersion,
      dueAt: when,
      reasonCode: reason,
      notes: notes.trim() || null,
    });
  }
  return (
    <div className="customer-modern sales-modern">
      <CustomerNumberGuard
        protectSearch
        dirty={
          (opened && !!due) ||
          priceRisk.dirty ||
          lossRisk.dirty ||
          issueRisk.dirty ||
          correctionRisk.dirty
        }
        unresolved={
          state.locked ||
          priceRisk.unresolved ||
          lossRisk.unresolved ||
          issueRisk.unresolved ||
          correctionRisk.unresolved
        }
        label="Takip planı"
      />
      <ReturnToWork fallback />
      <PageHeader title="Teklif çalışması" description="Müşteri görüşmesi ve takip planı" />
      {voidVerified && <p role="status">Çalışma geçersiz kılındı ve bağlı takip kapatıldı.</p>}
      {reopenedTaskId && (
        <p role="status">
          Çalışma yeniden açıldı ve yeni takip oluşturuldu.{' '}
          <Link to={`/tasks/${encodeURIComponent(reopenedTaskId)}`}>Yeni takibi aç</Link>
        </p>
      )}
      {issuedPolicyId && (
        <p role="status">
          Poliçe kaydı doğrulandı ve takip kapatıldı.{' '}
          <Link to={`/policies/${encodeURIComponent(issuedPolicyId)}`}>Poliçeyi aç</Link>
        </p>
      )}
      {summary.loading && <p role="status">Çalışma yükleniyor…</p>}
      {summary.error && <p role="alert">{summary.error.message}</p>}
      {summary.data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{summary.data.customerName}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="customer-info-grid">
                <div>
                  <dt>Branş</dt>
                  <dd>{summary.data.branchName}</dd>
                </div>
                <div>
                  <dt>Dönem sonu</dt>
                  <dd>
                    {summary.data.cycleDate ? cycleLabel(summary.data.cycleDate) : 'Belirtilmedi'}
                  </dd>
                </div>
              </dl>
              {summary.data.result === 'WON' && <p>Poliçelendirildi</p>}
              {summary.data.result === 'VOIDED' && <p>Geçersiz çalışma</p>}
              <Button asChild variant="outline">
                <Link to={`/customers/${summary.data.customerId}?section=sales`}>
                  Müşterinin teklif çalışmalarını aç
                </Link>
              </Button>
              {summary.data.predecessorCaseId && (
                <Button asChild variant="outline">
                  <Link to={`/sales-cases/${encodeURIComponent(summary.data.predecessorCaseId)}`}>
                    Önceki dönem çalışmasını aç
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>
          {summary.data.context === 'NEW_BUSINESS' &&
            summary.data.result === 'OPEN' &&
            task.data && (
              <SalesIssueSection
                caseId={id}
                expectedTaskId={task.data.taskId}
                canOperate={() =>
                  !opened &&
                  !state.locked &&
                  !priceRisk.dirty &&
                  !priceRisk.unresolved &&
                  !lossRisk.dirty &&
                  !lossRisk.unresolved &&
                  !correctionActive
                }
                onRisk={setIssueRisk}
                onChanged={(result) => {
                  setIssueRisk({ dirty: false, unresolved: false });
                  setReopenedTaskId(null);
                  setReopenedTaskId(null);
                  setIssuedPolicyId(result.policyId);
                  task.reload();
                  summary.reload();
                }}
              />
            )}
          <SalesPricesSection
            caseId={id}
            caseVersion={summary.data.version}
            onRisk={onPriceRisk}
            canOperate={() =>
              !opened &&
              !state.locked &&
              !lossRisk.dirty &&
              !lossRisk.unresolved &&
              !issueActive &&
              !correctionActive
            }
            onChanged={summary.reload}
          />
          {summary.data.context === 'RENEWAL' && summary.data.renewalId ? (
            <Card>
              <CardHeader>
                <CardTitle>Yenileme çalışması</CardTitle>
              </CardHeader>
              <CardContent>
                <p>
                  Teklifler, görüşmeler, takip ve poliçelendirme aynı yenileme kaydından yürütülür.
                </p>
                <Button asChild>
                  <Link to={`/renewals/${encodeURIComponent(summary.data.renewalId)}`}>
                    Yenilemeye git
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : summary.data.result === 'OPEN' ? (
            <Card>
              <CardHeader>
                <CardTitle>Takip planı</CardTitle>
              </CardHeader>
              <CardContent>
                {message && <p role="status">{message}</p>}
                <WriteNotice state={state} />
                {state.code === 'CONFLICT' && (
                  <Button
                    variant="outline"
                    disabled={state.locked}
                    onClick={() => {
                      summary.reload();
                      task.reload();
                    }}
                  >
                    Taslağı koru, güncel takibi kontrol et
                  </Button>
                )}
                {task.loading && <p role="status">Takip bilgileri yükleniyor…</p>}
                {task.error && (
                  <p>Bu çalışmanın kişisel takip işine erişiminiz yok veya takip kapanmış.</p>
                )}
                {task.data && (
                  <>
                    <p>
                      Takip zamanı:{' '}
                      <strong>
                        {new Intl.DateTimeFormat('tr-TR', {
                          timeZone: 'Europe/Istanbul',
                          dateStyle: 'long',
                          timeStyle: 'short',
                        }).format(new Date(task.data.dueAt))}
                      </strong>
                    </p>
                    {!opened && (
                      <div className="customer-form-actions">
                        <Button
                          disabled={
                            state.locked ||
                            priceRisk.dirty ||
                            priceRisk.unresolved ||
                            lossRisk.dirty ||
                            lossRisk.unresolved ||
                            issueActive ||
                            correctionActive
                          }
                          onClick={() => setOpened(true)}
                        >
                          Takip zamanını değiştir
                        </Button>
                        <Button asChild variant="outline">
                          <Link to={`/tasks/${encodeURIComponent(task.data.taskId)}`}>
                            Takip ayrıntıları
                          </Link>
                        </Button>
                      </div>
                    )}
                    {opened && (
                      <form
                        className="customer-edit-form sales-case-form"
                        aria-label="Takip zamanını değiştir"
                        method="post"
                        action={`/api/sales-cases/${id}/followup`}
                        onSubmit={submit}
                      >
                        {validation && <p role="alert">{validation}</p>}
                        <fieldset disabled={state.locked}>
                          <legend>Yeni takip planı</legend>
                          <label htmlFor="case-due">Takip zamanı · İstanbul (zorunlu)</label>
                          <input
                            id="case-due"
                            name="dueAt"
                            type="datetime-local"
                            required
                            value={due}
                            onChange={(e) => {
                              setDue(e.target.value);
                              setValidation('');
                            }}
                          />
                          <label htmlFor="case-reason">Takip nedeni</label>
                          <select
                            id="case-reason"
                            name="reason"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                          >
                            <option value="CALL_AGAIN">Tekrar aranacak</option>
                            <option value="CUSTOMER_RESPONSE_PENDING">
                              Müşterinin yanıtı bekleniyor
                            </option>
                            <option value="DOCUMENTS_PENDING">Evrak bekleniyor</option>
                            <option value="PRICE_REVISION_PENDING">Fiyat güncellenecek</option>
                          </select>
                          <label htmlFor="case-notes">Kısa not (isteğe bağlı)</label>
                          <textarea
                            id="case-notes"
                            name="notes"
                            rows={3}
                            maxLength={500}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                          />
                        </fieldset>
                        <div className="customer-form-actions">
                          <Button type="submit" disabled={state.locked}>
                            Takip planını kaydet
                          </Button>
                          <Button
                            variant="outline"
                            disabled={state.locked}
                            onClick={() => setOpened(false)}
                          >
                            Vazgeç
                          </Button>
                        </div>
                      </form>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          ) : null}
          {summary.data.context === 'NEW_BUSINESS' && (
            <SalesLossSection
              caseId={id}
              result={summary.data.result ?? 'OPEN'}
              canOperate={() =>
                !opened &&
                !state.locked &&
                !priceRisk.dirty &&
                !priceRisk.unresolved &&
                !issueActive &&
                !correctionActive
              }
              onRisk={onLossRisk}
              onChanged={() => {
                summary.reload();
                task.reload();
                setReopenedTaskId(null);
                setMessage('Sonuç kaydedildi.');
              }}
            />
          )}
          {summary.data.context === 'NEW_BUSINESS' &&
            summary.data.result === 'OPEN' &&
            task.data && (
              <SalesCaseCorrectionSection
                operation="void"
                caseId={id}
                taskId={task.data.taskId}
                canOperate={() =>
                  !opened &&
                  !state.locked &&
                  !priceRisk.dirty &&
                  !priceRisk.unresolved &&
                  !lossRisk.dirty &&
                  !lossRisk.unresolved &&
                  !issueActive
                }
                onRisk={setCorrectionRisk}
                onChanged={() => {
                  setCorrectionRisk({ dirty: false, unresolved: false });
                  setReopenedTaskId(null);
                  setVoidVerified(true);
                  task.reload();
                  summary.reload();
                }}
              />
            )}
          {summary.data.context === 'NEW_BUSINESS' &&
            summary.data.result === 'WON' &&
            !reopenedTaskId && (
              <SalesWonCorrectionSection
                caseId={id}
                canOperate={() =>
                  !opened &&
                  !state.locked &&
                  !priceRisk.dirty &&
                  !priceRisk.unresolved &&
                  !lossRisk.dirty &&
                  !lossRisk.unresolved &&
                  !issueActive
                }
                onRisk={setCorrectionRisk}
                onChanged={(taskId) => {
                  setCorrectionRisk({ dirty: false, unresolved: false });
                  setIssuedPolicyId(null);
                  setReopenedTaskId(taskId);
                  summary.reload();
                }}
              />
            )}
          {summary.data.context === 'NEW_BUSINESS' && summary.data.result === 'LOST' && (
            <SalesCaseCorrectionSection
              operation="reopen"
              caseId={id}
              canOperate={() =>
                !opened &&
                !state.locked &&
                !priceRisk.dirty &&
                !priceRisk.unresolved &&
                !lossRisk.dirty &&
                !lossRisk.unresolved &&
                !issueActive
              }
              onRisk={setCorrectionRisk}
              onChanged={(taskId) => {
                setCorrectionRisk({ dirty: false, unresolved: false });
                setReopenedTaskId(taskId);
                summary.reload();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
export default function SalesCasePage() {
  const { caseId = '' } = useParams();
  return <SalesCase key={caseId} id={caseId} />;
}

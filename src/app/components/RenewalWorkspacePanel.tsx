import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { WhatsAppPreviewPanel } from './WhatsAppPreviewPanel';
import {
  RenewalPolicySelector,
  completionMoney,
  type RenewalResultPolicy,
} from './RenewalPolicySelector';

interface VersionPayload {
  insurerId: string;
  productId: string;
  branchId: string;
  paymentMethodId: string;
  startDate: string;
  endDate: string;
  validUntil: string;
  grossPremiumMinor: number;
  currency: string;
  installmentCount: number | null;
  termsSummary: string | null;
}

interface WorkspaceData {
  interactions: Array<{
    id: string;
    outcome: 'CONTACT_CONFIRMED' | 'ATTEMPT_NO_RESPONSE' | 'WHATSAPP_OPENED' | 'NOTE';
    channel: string;
    occurred_at?: string | null;
    note?: string | null;
    actor_membership_id?: string | null;
  }>;
  lastContactAt: string | null;
  lastAttemptAt: string | null;
  customerType: 'INDIVIDUAL' | 'COMPANY';
  companyContacts: Array<{ id: string; displayName: string; role: string | null }>;
}

interface QuoteVersionRow {
  id: string;
  version_number: number;
  product_id: string;
  product_name: string;
  gross_premium_minor: number;
  currency: string;
  created_at: string;
}

interface QuoteRow {
  id: string;
  status: 'DRAFT' | 'READY' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
  version: number;
  current_version_id: string;
  accepted_version_id: string | null;
  versions: QuoteVersionRow[];
  events: Array<{ event: string; quote_version_id: string; occurred_at: string }>;
}

interface QuoteListData {
  quotes: QuoteRow[];
  defaultVersion: VersionPayload;
}

interface MutationResult {
  operationId: string;
  quoteId?: string;
  quoteVersionId?: string;
  versionNumber?: number;
  status?: string;
  interactionId?: string;
}

interface ActiveQuote {
  quoteId: string;
  quoteVersionId: string;
  versionNumber: number;
  quoteVersion: number;
  status: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code?: string };
}

interface Props {
  readonly renewalId: string;
  readonly customerId?: string;
  readonly customerDisplayName: string;
  readonly renewalVersion?: number;
  readonly taskId?: string;
  readonly taskVersion?: number;
  readonly renewalState?: string;
  readonly getCsrfToken: () => Promise<string>;
  readonly invalidateCsrfToken: () => void;
  readonly onTerminalOutcome?: () => void;
  readonly refreshCompletionVersions?: () => Promise<{
    renewalVersion: number;
    taskVersion: number;
  }>;
}

function outcomeLabel(outcome: WorkspaceData['interactions'][number]['outcome']): string {
  switch (outcome) {
    case 'CONTACT_CONFIRMED':
      return 'Gerçek temas doğrulandı';
    case 'ATTEMPT_NO_RESPONSE':
      return 'Temas denemesi — yanıt yok';
    case 'WHATSAPP_OPENED':
      return 'WhatsApp açıldı; gerçek temas değildir.';
    case 'NOTE':
      return 'Not';
    default:
      return 'Sonuç bilgisi bulunmuyor';
  }
}

function channelLabel(channel: string): string {
  switch (channel) {
    case 'PHONE':
      return 'Telefon';
    case 'EMAIL':
      return 'E-posta';
    case 'WHATSAPP':
      return 'WhatsApp';
    case 'IN_PERSON':
      return 'Yüz yüze';
    case 'OTHER':
      return 'Diğer';
    default:
      return 'Kanal bilgisi bulunmuyor';
  }
}

function interactionTimestamp(value: string | null | undefined): string | null {
  // Never infer the timezone of an incomplete historical timestamp.
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function dateLabel(value: string | null): string {
  if (!value) return 'henüz kaydedilmedi';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'tarih bilinmiyor';
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

async function readEnvelope<T>(response: Response): Promise<T> {
  let payload: ApiEnvelope<T>;
  try {
    payload = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new Error('Sunucu yanıtı okunamadı.');
  }
  if (!response.ok || !payload.success || payload.data === undefined) {
    if (response.status === 403 || response.status === 404) {
      throw new Error('Bu yenileme kaydına erişilemiyor.');
    }
    if (response.status === 409) {
      throw new Error('Kayıt değişti. Yenileyip tekrar deneyin.');
    }
    throw new Error('İşlem tamamlanamadı.');
  }
  return payload.data;
}

class CompletionConflictError extends Error {
  constructor() {
    super('Kayıt değişti. Taslağınız korundu; güncel bilgileri yükleyip poliçeyi yeniden seçin.');
  }
}

function mutationData(data: unknown): MutationResult {
  if (!data || typeof data !== 'object') throw new Error('İşlem sonucu okunamadı.');
  const candidate = data as { data?: unknown };
  const result = candidate.data && typeof candidate.data === 'object' ? candidate.data : data;
  if (!result || typeof result !== 'object') throw new Error('İşlem sonucu okunamadı.');
  return result as MutationResult;
}

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function RenewalWorkspacePanel({
  renewalId,
  customerId,
  customerDisplayName,
  renewalVersion = 1,
  taskId,
  taskVersion = 1,
  renewalState = 'CONTACT_PENDING',
  getCsrfToken,
  invalidateCsrfToken,
  onTerminalOutcome,
  refreshCompletionVersions,
}: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [quoteData, setQuoteData] = useState<QuoteListData | null>(null);
  const [policyPreview, setPolicyPreview] = useState<RenewalResultPolicy | null>(null);
  const [activeQuote, setActiveQuote] = useState<ActiveQuote | null>(null);
  const [outcome, setOutcome] =
    useState<WorkspaceData['interactions'][number]['outcome']>('CONTACT_CONFIRMED');
  const [channel, setChannel] = useState('PHONE');
  const [companyContactId, setCompanyContactId] = useState('');
  const [note, setNote] = useState('');
  const [premiumMinor, setPremiumMinor] = useState('');
  const [terminalAction, setTerminalAction] = useState<'NONE' | 'WON' | 'LOST' | 'VOIDED'>('NONE');
  const [lossReasonId, setLossReasonId] = useState('');
  const [lossReasonNotes, setLossReasonNotes] = useState('');
  const [lossReasons, setLossReasons] = useState<Array<{ id: string; code: string; name: string }>>(
    [],
  );
  const [catalogError, setCatalogError] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [completionConflict, setCompletionConflict] = useState(false);
  const [completionVersions, setCompletionVersions] = useState<{
    renewalVersion: number;
    taskVersion: number;
  } | null>(null);
  const [policyRefresh, setPolicyRefresh] = useState(0);
  const [voidReasonCode, setVoidReasonCode] = useState('TECHNICAL_ERROR');
  const [acceptedQuoteVersionId, setAcceptedQuoteVersionId] = useState('');
  const [quoteDifferenceReasonCode, setQuoteDifferenceReasonCode] = useState('');
  const requestGeneration = useRef(0);
  const attempts = useRef(new Map<string, { body: string; key: string }>());
  const selectedLossReason = lossReasons.find((reason) => reason.id === lossReasonId);

  useEffect(() => {
    if (!open || terminalAction !== 'LOST') return;
    let current = true;
    setCatalogLoading(true);
    setCatalogError('');
    void fetch('/api/catalogs/selectable', { cache: 'no-store' })
      .then(readEnvelope<{ lossReasons: Array<{ id: string; code: string; name: string }> }>)
      .then((data) => {
        if (current) setLossReasons(data.lossReasons);
      })
      .catch(() => {
        if (current) {
          setLossReasons([]);
          setCatalogError('Kayıp nedenleri yüklenemedi veya erişilemiyor.');
        }
      })
      .finally(() => {
        if (current) setCatalogLoading(false);
      });
    return () => {
      current = false;
    };
  }, [open, terminalAction, catalogRefresh]);

  const loadResources = useCallback(async () => {
    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    try {
      const [interactionResult, quoteResult] = await Promise.allSettled([
        fetch(`/api/renewals/${encodeURIComponent(renewalId)}/interactions`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        }).then(readEnvelope<WorkspaceData>),
        fetch(`/api/renewals/${encodeURIComponent(renewalId)}/quotes`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        }).then(readEnvelope<QuoteListData>),
      ]);
      if (generation !== requestGeneration.current) return;
      // Independent permissions and failures: Quote read must not gate authorized communication.
      if (interactionResult.status === 'fulfilled') {
        const interactionData = interactionResult.value;
        setWorkspace(interactionData);
        if (!companyContactId && interactionData.companyContacts.length === 1) {
          setCompanyContactId(interactionData.companyContacts[0]!.id);
        }
      } else {
        setWorkspace(null);
      }
      if (quoteResult.status === 'fulfilled') {
        const quotes = quoteResult.value;
        setQuoteData(quotes);
        setPremiumMinor(String(quotes.defaultVersion.grossPremiumMinor));
        if (!activeQuote && quotes.quotes.length > 0) {
          const latest = quotes.quotes[quotes.quotes.length - 1]!;
          const current = latest.versions.find(
            (version) => version.id === latest.current_version_id,
          );
          if (current) {
            setActiveQuote({
              quoteId: latest.id,
              quoteVersionId: current.id,
              versionNumber: current.version_number,
              quoteVersion: latest.version,
              status: latest.status,
            });
          }
        }
      } else {
        setQuoteData(null);
        setActiveQuote(null);
      }
      const errors = [
        interactionResult.status === 'rejected'
          ? 'İletişim bilgileri yüklenemedi veya erişilemiyor.'
          : null,
        quoteResult.status === 'rejected'
          ? 'Teklif bilgileri yüklenemedi veya erişilemiyor.'
          : null,
      ].filter(Boolean);
      setError(errors.length ? errors.join(' ') : null);
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      setError(caught instanceof Error ? caught.message : 'Bilgiler yüklenemedi.');
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [activeQuote, companyContactId, renewalId]);

  useEffect(() => {
    if (open) void loadResources();
    return () => {
      requestGeneration.current += 1;
    };
  }, [loadResources, open]);

  const post = useCallback(
    async (url: string, payload: unknown, operation: string): Promise<MutationResult> => {
      const body = JSON.stringify(payload);
      const attemptId = `${url}\u0000${body}`;
      const prior = attempts.current.get(attemptId);
      const key = prior?.body === body ? prior.key : newIdempotencyKey();
      attempts.current.set(attemptId, { body, key });
      const csrfToken = await getCsrfToken();
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
          'Idempotency-Key': key,
        },
        body,
      });
      if (response.status === 409 && (url.endsWith('/close-won') || url.endsWith('/close-lost')))
        throw new CompletionConflictError();
      const data = await readEnvelope<unknown>(response);
      attempts.current.delete(attemptId);
      setMessage(operation);
      setError(null);
      return mutationData(data);
    },
    [getCsrfToken],
  );

  async function submitInteraction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      await post(
        `/api/renewals/${encodeURIComponent(renewalId)}/interactions`,
        {
          outcome,
          channel,
          companyContactId: workspace?.customerType === 'COMPANY' ? companyContactId : null,
          note: outcome === 'NOTE' ? note : null,
          occurredAt: new Date().toISOString(),
        },
        outcome === 'CONTACT_CONFIRMED'
          ? 'Gerçek temas kaydedildi.'
          : outcome === 'ATTEMPT_NO_RESPONSE'
            ? 'Deneme kaydedildi; bu gerçek temas sayılmaz.'
            : outcome === 'WHATSAPP_OPENED'
              ? 'WhatsApp açıldı; gerçek temas değildir.'
              : 'Not kaydedildi.',
      );
      setNote('');
      await loadResources();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Görüşme kaydedilemedi.');
      if (caught instanceof Error && caught.message.includes('CSRF')) invalidateCsrfToken();
    } finally {
      setSaving(false);
    }
  }

  function versionPayload(): VersionPayload | null {
    if (!quoteData) return null;
    const amount = Number(premiumMinor);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      setError('Prim, para biriminin minor unit cinsinden tam sayı olmalıdır.');
      return null;
    }
    return { ...quoteData.defaultVersion, grossPremiumMinor: amount };
  }

  async function createQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const version = versionPayload();
    if (!version) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await post(
        `/api/renewals/${encodeURIComponent(renewalId)}/quotes`,
        { expectedRenewalVersion: renewalVersion, version },
        'Teklif taslağı oluşturuldu.',
      );
      if (!result.quoteId || !result.quoteVersionId) throw new Error('Teklif sonucu okunamadı.');
      setActiveQuote({
        quoteId: result.quoteId,
        quoteVersionId: result.quoteVersionId,
        versionNumber: result.versionNumber ?? 1,
        quoteVersion: 1,
        status: result.status ?? 'DRAFT',
      });
      await loadResources();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Teklif oluşturulamadı.');
    } finally {
      setSaving(false);
    }
  }

  async function createQuoteVersion() {
    if (!activeQuote) return;
    const version = versionPayload();
    if (!version) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await post(
        `/api/renewals/${encodeURIComponent(renewalId)}/quotes/${encodeURIComponent(activeQuote.quoteId)}/versions`,
        { expectedQuoteVersion: activeQuote.quoteVersion, version },
        'Yeni ve değiştirilemeyen teklif sürümü oluşturuldu.',
      );
      if (!result.quoteVersionId) throw new Error('Teklif sürümü sonucu okunamadı.');
      setActiveQuote({
        ...activeQuote,
        quoteVersionId: result.quoteVersionId,
        versionNumber: result.versionNumber ?? activeQuote.versionNumber + 1,
        quoteVersion: activeQuote.quoteVersion + 1,
        status: 'DRAFT',
      });
      await loadResources();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Yeni teklif sürümü oluşturulamadı.');
    } finally {
      setSaving(false);
    }
  }

  async function sendQuote() {
    if (!activeQuote) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await post(
        `/api/renewals/${encodeURIComponent(renewalId)}/quotes/${encodeURIComponent(activeQuote.quoteId)}/send`,
        {
          expectedQuoteVersion: activeQuote.quoteVersion,
          quoteVersionId: activeQuote.quoteVersionId,
        },
        `Teklif sürümü ${activeQuote.versionNumber} gönderildi.`,
      );
      setActiveQuote({
        ...activeQuote,
        quoteVersion: activeQuote.quoteVersion + 1,
        status: result.status ?? 'SENT',
      });
      setAcceptedQuoteVersionId(activeQuote.quoteVersionId);
      await loadResources();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Teklif gönderilemedi.');
    } finally {
      setSaving(false);
    }
  }

  async function submitTerminal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!taskId) {
      setError('Bu görev için terminal işlemi kullanılamıyor.');
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const versions = completionVersions ?? { renewalVersion, taskVersion };
      if (completionConflict) throw new CompletionConflictError();
      if (terminalAction === 'WON' && !policyPreview) throw new Error('Güncel bir poliçe seçin.');
      if (terminalAction === 'LOST' && (!selectedLossReason || catalogLoading || catalogError))
        throw new Error('Geçerli bir kayıp nedeni seçin.');
      if (
        terminalAction === 'LOST' &&
        selectedLossReason?.code === 'OTHER' &&
        !lossReasonNotes.trim()
      )
        throw new Error('Diğer kayıp nedeni için açıklama zorunludur.');
      let quoteDifferenceReasonCodeToSend: string | undefined;
      if (terminalAction === 'WON' && acceptedQuoteVersionId) {
        const quoteVersion = quoteData?.quotes
          .flatMap((quote) => quote.versions)
          .find((version) => version.id === acceptedQuoteVersionId);
        if (!quoteVersion) throw new Error('Gönderilmiş teklif sürümü bulunamadı.');
        const targetPolicy = policyPreview!;
        const differsFromQuote =
          quoteVersion.product_id !== targetPolicy.product.id ||
          quoteVersion.gross_premium_minor !== targetPolicy.grossPremiumMinor ||
          quoteVersion.currency !== targetPolicy.currency;
        if (differsFromQuote) {
          const reasonCode = quoteDifferenceReasonCode.trim();
          if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(reasonCode)) {
            setError('Ürün/prim farkı için geçerli bir gerekçe kodu girin.');
            return;
          }
          quoteDifferenceReasonCodeToSend = reasonCode;
        } else if (quoteDifferenceReasonCode.trim()) {
          setError('Teklif ile eşleşen poliçeye fark gerekçe kodu verilemez.');
          return;
        }
      }
      const url =
        terminalAction === 'WON'
          ? `/api/renewals/${encodeURIComponent(renewalId)}/close-won`
          : terminalAction === 'LOST'
            ? `/api/renewals/${encodeURIComponent(renewalId)}/close-lost`
            : `/api/renewals/${encodeURIComponent(renewalId)}/void`;
      const payload =
        terminalAction === 'WON'
          ? {
              expectedRenewalVersion: versions.renewalVersion,
              expectedTaskVersion: versions.taskVersion,
              result: {
                kind: 'LINK_POLICY',
                newPolicyId: policyPreview!.id,
                expectedPolicyVersion: policyPreview!.version,
                allocatedNewPremiumMinor: policyPreview!.grossPremiumMinor,
                currency: policyPreview!.currency,
              },
              ...(acceptedQuoteVersionId ? { acceptedQuoteVersionId } : {}),
              ...(quoteDifferenceReasonCodeToSend
                ? { quoteDifferenceReasonCode: quoteDifferenceReasonCodeToSend }
                : {}),
            }
          : terminalAction === 'LOST'
            ? {
                expectedRenewalVersion: versions.renewalVersion,
                expectedTaskVersion: versions.taskVersion,
                lossReasonId,
                lossReasonNotes:
                  selectedLossReason?.code === 'OTHER' ? lossReasonNotes.trim() : null,
              }
            : {
                expectedRenewalVersion: renewalVersion,
                expectedTaskVersion: taskVersion,
                voidReasonCode,
              };
      await post(url, payload, `${terminalAction} sonucu kaydedildi.`);
      onTerminalOutcome?.();
      await loadResources();
    } catch (caught) {
      if (caught instanceof CompletionConflictError) setCompletionConflict(true);
      setError(caught instanceof Error ? caught.message : 'Terminal sonuç kaydedilemedi.');
    } finally {
      setSaving(false);
    }
  }

  const sentVersions =
    quoteData?.quotes.flatMap((quote) =>
      quote.events
        .filter((event) => event.event === 'SENT')
        .map((event) => ({
          quoteId: quote.id,
          versionId: event.quote_version_id,
          versionNumber: quote.versions.find((version) => version.id === event.quote_version_id)
            ?.version_number,
        })),
    ) ?? [];
  const selectedQuoteVersion = quoteData?.quotes
    .flatMap((quote) => quote.versions)
    .find((version) => version.id === acceptedQuoteVersionId);
  const quoteDifference =
    selectedQuoteVersion && policyPreview
      ? selectedQuoteVersion.product_id !== policyPreview.product.id ||
        selectedQuoteVersion.gross_premium_minor !== policyPreview.grossPremiumMinor ||
        selectedQuoteVersion.currency !== policyPreview.currency
      : false;

  return (
    <section
      style={{ marginTop: '0.75rem', borderTop: '1px solid #e2e8f0', paddingTop: '0.75rem' }}
    >
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        İletişim, teklif ve sonuçları {open ? 'kapat' : 'aç'}: {customerDisplayName}
      </button>
      {open && (
        <div style={{ display: 'grid', gap: '0.75rem', marginTop: '0.75rem' }}>
          {loading && <p role="status">İletişim ve teklifler yükleniyor…</p>}
          {error && <p role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}
          {workspace && (
            <>
              <div aria-label={`Temas özeti: ${customerDisplayName}`}>
                <p>Başarılı temas: {dateLabel(workspace.lastContactAt)}</p>
                <p>Son deneme: {dateLabel(workspace.lastAttemptAt)}</p>
              </div>
              <form onSubmit={(event) => void submitInteraction(event)}>
                <h4>İletişim kaydı</h4>
                <label>
                  Görüşme sonucu: {customerDisplayName}
                  <select
                    value={outcome}
                    onChange={(event) => setOutcome(event.target.value as typeof outcome)}
                  >
                    <option value="CONTACT_CONFIRMED">Gerçek temas doğrulandı</option>
                    <option value="ATTEMPT_NO_RESPONSE">Temas denemesi — yanıt yok</option>

                    <option value="NOTE">Yalnızca not</option>
                  </select>
                </label>
                <label>
                  İletişim kanalı: {customerDisplayName}
                  <select value={channel} onChange={(event) => setChannel(event.target.value)}>
                    <option value="PHONE">Telefon</option>
                    <option value="EMAIL">E-posta</option>
                    <option value="WHATSAPP">WhatsApp</option>
                    <option value="IN_PERSON">Yüz yüze</option>
                    <option value="OTHER">Diğer</option>
                  </select>
                </label>
                {workspace.customerType === 'COMPANY' && (
                  <label>
                    Şirket yetkilisi: {customerDisplayName}
                    <select
                      value={companyContactId}
                      onChange={(event) => setCompanyContactId(event.target.value)}
                      required
                    >
                      <option value="">Yetkili seçin</option>
                      {workspace.companyContacts.map((contact) => (
                        <option key={contact.id} value={contact.id}>
                          {contact.displayName}
                          {contact.role ? ` — ${contact.role}` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {outcome === 'NOTE' && (
                  <label>
                    Not: {customerDisplayName}
                    <textarea
                      value={note}
                      maxLength={1000}
                      onChange={(event) => setNote(event.target.value)}
                      required
                    />
                  </label>
                )}
                <button type="submit" disabled={saving || loading}>
                  Görüşmeyi kaydet: {customerDisplayName}
                </button>
              </form>
              <h4>İletişim geçmişi</h4>
              <p>Tarihler Türkiye saatiyle (Europe/Istanbul) gösterilir.</p>
              {workspace.interactions.length === 0 && <p>Henüz iletişim kaydı yok.</p>}
              <ul
                aria-label={`İletişim geçmişi: ${customerDisplayName}`}
                style={{ display: 'grid', gap: '0.75rem', paddingLeft: '1.25rem' }}
              >
                {workspace.interactions.map((interaction) => {
                  const timestamp = interactionTimestamp(interaction.occurred_at);
                  return (
                    <li key={interaction.id} style={{ overflowWrap: 'anywhere' }}>
                      <div style={{ fontWeight: 600 }}>
                        {outcomeLabel(interaction.outcome)} — {channelLabel(interaction.channel)}
                      </div>
                      <div>
                        {timestamp ? (
                          <time dateTime={timestamp}>{dateLabel(timestamp)}</time>
                        ) : (
                          <span>Tarih bilgisi bulunmuyor</span>
                        )}
                      </div>
                      {/* The authorized history DTO has no employee name. Do not fetch
                        OWNER personnel data or present an internal ID as a name. */}
                      <p style={{ color: '#475569', margin: '0.25rem 0' }}>
                        Kaydeden: Çalışan adı mevcut değil
                      </p>
                      {typeof interaction.note === 'string' && interaction.note.trim() && (
                        <p style={{ whiteSpace: 'pre-wrap', margin: '0.25rem 0' }}>
                          {interaction.note}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
              <WhatsAppPreviewPanel
                key={`${renewalId}:${companyContactId}`}
                renewalId={renewalId}
                companyContactId={
                  workspace.customerType === 'COMPANY' ? companyContactId || null : null
                }
                contactRequired={workspace.customerType === 'COMPANY'}
                getCsrfToken={getCsrfToken}
                invalidateCsrfToken={invalidateCsrfToken}
                onOpened={() => void loadResources()}
              />
            </>
          )}
          {quoteData && (
            <>
              <form onSubmit={(event) => void createQuote(event)}>
                <h4>Yenileme teklifi</h4>
                <label>
                  Prim (minor unit): {customerDisplayName}
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={premiumMinor}
                    onChange={(event) => setPremiumMinor(event.target.value)}
                  />
                </label>
                <p>
                  Tutarlar {quoteData.defaultVersion.currency} cinsinden tam minor-unit integer
                  olarak kaydedilir.
                </p>
                <button type="submit" disabled={saving || loading || Boolean(activeQuote)}>
                  Teklif oluştur: {customerDisplayName}
                </button>
              </form>
              {activeQuote && (
                <div>
                  <p>
                    Teklif {activeQuote.status} · sürüm {activeQuote.versionNumber}
                    {activeQuote.status === 'SENT' && ' · Gönderilen sürüm değiştirilemez.'}
                  </p>
                  {activeQuote.status !== 'SENT' && activeQuote.status !== 'ACCEPTED' && (
                    <button type="button" disabled={saving} onClick={() => void sendQuote()}>
                      Teklif sürümü {activeQuote.versionNumber}’i gönder: {customerDisplayName}
                    </button>
                  )}
                  {activeQuote.status !== 'ACCEPTED' && (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void createQuoteVersion()}
                    >
                      Yeni teklif sürümü oluştur: {customerDisplayName}
                    </button>
                  )}
                </div>
              )}
              {quoteData.quotes.map((quote) => (
                <div key={quote.id}>
                  <p>
                    {quote.status} · {quote.versions.length} değiştirilemeyen sürüm
                  </p>
                  <ul>
                    {quote.versions.map((version) => (
                      <li key={version.id}>
                        v{version.version_number}: {version.gross_premium_minor} {version.currency}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
          {taskId && !['WON', 'LOST', 'VOIDED'].includes(renewalState) && (
            <form onSubmit={(event) => void submitTerminal(event)}>
              <h4>Yenilemeyi sonuçlandır</h4>
              <label>
                Sonuç türü: {customerDisplayName}
                <select
                  value={terminalAction}
                  onChange={(event) =>
                    setTerminalAction(event.target.value as typeof terminalAction)
                  }
                >
                  <option value="NONE">Sonuç seçin</option>
                  <option value="WON">Kazanıldı — yeni poliçeyi bağla</option>
                  <option value="LOST">Kaybedildi</option>
                  <option value="VOIDED">VOIDED</option>
                </select>
              </label>
              {terminalAction === 'WON' && (
                <>
                  <RenewalPolicySelector
                    customerId={customerId}
                    customerName={customerDisplayName}
                    selected={policyPreview}
                    onSelect={(policy) => {
                      setPolicyPreview(policy);
                      setQuoteDifferenceReasonCode('');
                    }}
                    disabled={saving}
                    refreshKey={policyRefresh}
                  />
                  {sentVersions.length > 0 && (
                    <label>
                      Kabul edilen teklif sürümü: {customerDisplayName}
                      <select
                        value={acceptedQuoteVersionId}
                        onChange={(event) => {
                          setAcceptedQuoteVersionId(event.target.value);
                          setQuoteDifferenceReasonCode('');
                        }}
                      >
                        <option value="">Teklif kabulü bağlama</option>
                        {sentVersions.map((version) => (
                          <option key={version.versionId} value={version.versionId}>
                            v{version.versionNumber}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {quoteDifference && selectedQuoteVersion && policyPreview && (
                    <>
                      <div role="status">
                        <p>Teklif ve poliçe arasında ürün/prim farkı var.</p>
                        <p>
                          Teklif: {selectedQuoteVersion.product_name} ·{' '}
                          {completionMoney(
                            selectedQuoteVersion.gross_premium_minor,
                            selectedQuoteVersion.currency,
                          )}
                        </p>
                        <p>
                          Poliçe: {policyPreview.product.name} ·{' '}
                          {completionMoney(policyPreview.grossPremiumMinor, policyPreview.currency)}
                        </p>
                      </div>
                      <label>
                        Ürün/prim farkı nedeni: {customerDisplayName}
                        <select
                          value={quoteDifferenceReasonCode}
                          onChange={(event) => setQuoteDifferenceReasonCode(event.target.value)}
                          required
                        >
                          <option value="">Neden seçin</option>
                          <option value="INSURER_REQUOTE">Sigortacının güncel teklifi</option>
                          <option value="COVERAGE_CHANGED">Ürün veya teminat değişikliği</option>
                          <option value="CUSTOMER_APPROVED_CHANGE">
                            Müşterinin onayladığı değişiklik
                          </option>
                        </select>
                      </label>
                    </>
                  )}
                </>
              )}
              {terminalAction === 'LOST' && (
                <>
                  <label>
                    Kayıp nedeni: {customerDisplayName}
                    <select
                      value={lossReasonId}
                      onChange={(event) => setLossReasonId(event.target.value)}
                      disabled={catalogLoading || saving}
                      required
                    >
                      <option value="">Kayıp nedeni seçin</option>
                      {lossReasons.map((reason) => (
                        <option key={reason.id} value={reason.id}>
                          {reason.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedLossReason?.code === 'OTHER' && (
                    <label>
                      Kayıp açıklaması: {customerDisplayName}
                      <textarea
                        value={lossReasonNotes}
                        onChange={(event) => setLossReasonNotes(event.target.value)}
                        maxLength={500}
                        required
                      />
                    </label>
                  )}
                  {catalogError && <p role="alert">{catalogError}</p>}
                  {catalogLoading && <p role="status">Kayıp nedenleri yükleniyor…</p>}
                  <button
                    type="button"
                    disabled={catalogLoading || saving}
                    onClick={() => setCatalogRefresh((value) => value + 1)}
                  >
                    Kayıp nedenlerini yenile
                  </button>
                </>
              )}
              {terminalAction === 'VOIDED' && (
                <label>
                  Void nedeni: {customerDisplayName}
                  <select
                    value={voidReasonCode}
                    onChange={(event) => setVoidReasonCode(event.target.value)}
                  >
                    <option value="TECHNICAL_ERROR">Teknik hata</option>
                    <option value="DUPLICATE">Yinelenen kayıt</option>
                    <option value="NOT_ELIGIBLE_AFTER_CANCELLATION_OR_RESTRUCTURE">
                      Uygun değil
                    </option>
                  </select>
                </label>
              )}
              {terminalAction !== 'NONE' && (
                <button
                  type="submit"
                  disabled={
                    saving ||
                    completionConflict ||
                    (terminalAction === 'WON' && !policyPreview) ||
                    (terminalAction === 'LOST' &&
                      (!selectedLossReason || catalogLoading || Boolean(catalogError)))
                  }
                >
                  {terminalAction === 'WON'
                    ? 'Kazanıldı'
                    : terminalAction === 'LOST'
                      ? 'Kaybedildi'
                      : 'VOIDED'}{' '}
                  sonucunu kaydet: {customerDisplayName}
                </button>
              )}
              {completionConflict && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    try {
                      if (!refreshCompletionVersions)
                        throw new Error(
                          'İş listesini yenileyip bu yenilemeyi tekrar açın. Taslağınız bu ekranda korunuyor.',
                        );
                      const versions = await refreshCompletionVersions();
                      setCompletionVersions(versions);
                      setPolicyPreview(null);
                      setPolicyRefresh((value) => value + 1);
                      setCompletionConflict(false);
                      setError(null);
                      setMessage(
                        'Güncel iş bilgileri yüklendi. Seçimlerinizi kontrol edip yeniden onaylayın.',
                      );
                    } catch {
                      setError(
                        'Güncel iş bilgileri yüklenemedi veya iş artık erişilebilir değil. Taslağınız korundu; iş listesinden kaydı yeniden kontrol edin.',
                      );
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  Güncel bilgileri yükle / poliçeyi yeniden seç
                </button>
              )}
            </form>
          )}
        </div>
      )}
    </section>
  );
}

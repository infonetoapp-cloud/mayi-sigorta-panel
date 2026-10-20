import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiResponse } from '../../../shared/types';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { parseAppError } from '../../App';
import { CustomerReadError, readCustomerResource } from '../customers/customer-resource';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
  canonicalOccurrence,
  localOccurrence,
  interactionTime,
  interactionOutcomes,
  interactionChannels,
  type InteractionHistory,
  type InteractionOutcome,
  type InteractionChannel,
  type InteractionRisk,
} from './interaction-model';
interface Payload {
  outcome: InteractionOutcome;
  channel: InteractionChannel;
  occurredAt: string;
  companyContactId: string | null;
  note: string | null;
}
interface Attempt {
  url: string;
  method: 'POST';
  body: string;
  key: string;
}
interface Result {
  interactionId: string;
  renewalId: string;
  outcome: string;
  occurredAt: string;
}
export function RenewalInteractionsSection({
  renewalId,
  onRiskChange,
}: {
  renewalId: string;
  onRiskChange: (risk: InteractionRisk) => void;
}) {
  const url = `/api/renewals/${encodeURIComponent(renewalId)}/interactions`;
  const [data, setData] = useState<InteractionHistory | null>(null),
    [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [mustRefresh, setMustRefresh] = useState(false),
    [comparison, setComparison] = useState(false),
    [reconfirmed, setReconfirmed] = useState(false),
    [needsRead, setNeedsRead] = useState(false),
    [pending, setPending] = useState<Attempt | null>(null),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  const [outcome, setOutcome] = useState<InteractionOutcome | ''>(''),
    [channel, setChannel] = useState<InteractionChannel | ''>(''),
    [occurred, setOccurred] = useState(''),
    [contact, setContact] = useState(''),
    [note, setNote] = useState(''),
    [contactConfirmed, setContactConfirmed] = useState(false);
  const epoch = useRef(0),
    readGeneration = useRef(0),
    reader = useRef<AbortController | null>(null),
    csrfReaders = useRef(new Set<AbortController>()),
    saving = useRef(false),
    completed = useRef<{ id: string; payload: Payload } | null>(null),
    formHeading = useRef<HTMLHeadingElement>(null),
    historyHeading = useRef<HTMLHeadingElement>(null),
    restoreFocus = useRef(false);
  const risk: InteractionRisk = needsRead
    ? 'saved-unread'
    : pending || (busy && opened)
      ? 'uncertain'
      : opened
        ? 'draft'
        : 'clean';
  useEffect(() => {
    onRiskChange(risk);
  }, [risk, onRiskChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (risk !== 'clean') {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [risk]);
  useEffect(() => {
    if (opened) formHeading.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      historyHeading.current?.focus();
    }
  }, [opened]);
  useEffect(() => {
    void load('initial');
    return () => {
      epoch.current++;
      readGeneration.current++;
      reader.current?.abort();
      for (const c of csrfReaders.current) c.abort();
      onRiskChange('clean');
    };
  }, []);
  async function load(mode: 'initial' | 'refresh' | 'readback') {
    const view = epoch.current,
      request = ++readGeneration.current;
    reader.current?.abort();
    const c = new AbortController();
    reader.current = c;
    setBusy(true);
    setError('');
    try {
      const fresh = await readCustomerResource<InteractionHistory>(url, c.signal);
      if (view !== epoch.current || request !== readGeneration.current) return;
      if (
        !Array.isArray(fresh.interactions) ||
        !Array.isArray(fresh.companyContacts) ||
        !['INDIVIDUAL', 'COMPANY'].includes(fresh.customerType)
      )
        throw new CustomerReadError(500);
      if (completed.current) {
        const proof = completed.current,
          row = fresh.interactions.find((item) => item.id === proof.id),
          p = proof.payload;
        if (
          !row ||
          row.outcome !== p.outcome ||
          row.channel !== p.channel ||
          row.occurred_at !== p.occurredAt ||
          (row.company_contact_id ?? null) !== p.companyContactId ||
          (row.note ?? null) !== p.note
        )
          throw new Error('READBACK_PROOF_MISSING');
      }
      setData(fresh);
      setBlocked(false);
      setMustRefresh(false);
      if (completed.current) {
        completed.current = null;
        setNeedsRead(false);
        setOpened(false);
        setComparison(false);
        setSuccess('İletişim kaydı kaydedildi ve geçmiş güncellendi.');
        restoreFocus.current = true;
        onRiskChange('clean');
      } else if (mode === 'refresh' && opened) {
        setComparison(true);
        setReconfirmed(false);
        setContactConfirmed(false);
      }
    } catch (cause) {
      if (c.signal.aborted || view !== epoch.current || request !== readGeneration.current) return;
      const denied =
        cause instanceof CustomerReadError && [400, 401, 403, 404, 409].includes(cause.status);
      if (denied) {
        setData(null);
        setBlocked(true);
        setMustRefresh(true);
      }
      setError(
        completed.current
          ? 'Kayıt kabul edildi; iletişim geçmişi henüz doğrulanamadı. Yalnız sonucu kontrol edin; kayıt yeniden gönderilmeyecek.'
          : denied
            ? 'İletişim bilgilerine erişilemiyor. Taslak güvenli olduğu sürece yalnız bu ekranın belleğinde korunur; güncel yetkili okuma olmadan yeniden gönderilemez.'
            : 'İletişim geçmişi yüklenemedi. Yeniden okuyun.',
      );
    } finally {
      if (view === epoch.current && request === readGeneration.current) setBusy(false);
    }
  }
  async function send(attempt: Attempt) {
    if (saving.current || blocked || mustRefresh || needsRead) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setSuccess('');
    onRiskChange('uncertain');
    const view = epoch.current;
    try {
      const c = new AbortController();
      csrfReaders.current.add(c);
      let csrf: string;
      try {
        csrf = await getCsrfToken(c.signal);
      } finally {
        csrfReaders.current.delete(c);
      }
      if (view !== epoch.current) return;
      // Do not pretend aborting the UI cancels a POST already received by the server.
      const r = await fetch(attempt.url, {
        method: attempt.method,
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': attempt.key,
        },
        body: attempt.body,
      });
      if (view !== epoch.current) return;
      if (r.status === 401) {
        parseAppError(401);
        setBlocked(true);
        setMustRefresh(true);
        setData(null);
        setError('Oturum sona erdi. Yeniden giriş yapın.');
        return;
      }
      const envelope = (await r.json().catch(() => null)) as ApiResponse<Result> | null;
      if (view !== epoch.current) return;
      if (!r.ok) {
        if (r.status >= 500 || r.status === 429 || r.status === 408) throw new Error('UNCERTAIN');
        setPending(null);
        const info = parseAppError(
          r.status,
          envelope && !envelope.success ? envelope.error : undefined,
        );
        if (r.status === 403) invalidateCsrfToken();
        if ([403, 404].includes(r.status)) {
          setData(null);
          setBlocked(true);
          setMustRefresh(true);
        }
        if (r.status === 409) {
          setMustRefresh(true);
          setComparison(false);
          setReconfirmed(false);
        }
        setError(
          r.status === 409
            ? 'Güncel kayıt veya yetkili bilgisi değişti. Taslağınız korundu; geçmişi ve yetkilileri yeniden okuyup açıkça onaylayın.'
            : info.message,
        );
        return;
      }
      const payload = JSON.parse(attempt.body) as Payload;
      if (
        !envelope?.success ||
        envelope.data.renewalId !== renewalId ||
        typeof envelope.data.interactionId !== 'string' ||
        envelope.data.outcome !== payload.outcome ||
        envelope.data.occurredAt !== payload.occurredAt
      )
        throw new Error('UNCERTAIN');
      completed.current = { id: envelope.data.interactionId, payload };
      setPending(null);
      setNeedsRead(true);
      onRiskChange('saved-unread');
      await load('readback');
    } catch {
      if (view === epoch.current) {
        setPending(attempt);
        setError(
          'Yazım sonucu belirsiz. Tarih, body ve anahtar donduruldu; yalnız aynı isteği yeniden deneyin. Ayrılmak sunucudaki isteği iptal etmez.',
        );
      }
    } finally {
      saving.current = false;
      if (view === epoch.current) setBusy(false);
    }
  }
  const locked = busy || blocked || mustRefresh || !!pending || needsRead;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || saving.current || !data) return;
    const timestamp = canonicalOccurrence(occurred),
      companyContactId = data.customerType === 'COMPANY' ? contact : null;
    if (
      !outcome ||
      !channel ||
      !timestamp ||
      (outcome === 'NOTE' && (!note.trim() || note.trim().length > 1000 || channel !== 'OTHER')) ||
      (outcome === 'CONTACT_CONFIRMED' && !contactConfirmed) ||
      (data.customerType === 'COMPANY' &&
        !data.companyContacts.some((row) => row.id === contact)) ||
      (comparison && !reconfirmed)
    ) {
      setError(
        'Sonuç, kanal, geçerli ve tek anlamlı İstanbul zamanı, gerekli açık yetkili seçimi ve onayları kontrol edin. Not: Diğer kanalı ve en fazla1000 karakterli dolu içerik gerektirir.',
      );
      return;
    }
    const payload: Payload = {
      outcome,
      channel,
      occurredAt: timestamp!,
      companyContactId,
      note: outcome === 'NOTE' ? note.trim() : null,
    };
    void send({ url, method: 'POST', body: JSON.stringify(payload), key: crypto.randomUUID() });
  }
  function edited() {
    setReconfirmed(false);
    setContactConfirmed(false);
    setSuccess('');
    onRiskChange('draft');
  }
  return (
    <section className="renewal-interactions" aria-label="Yenileme iletişim geçmişi ve kaydı">
      <h3 ref={historyHeading} tabIndex={-1}>
        İletişim geçmişi
      </h3>
      <details className="workspace-help">
        <summary>İletişim kayıtları hakkında</summary>
        <p className="today-clock">
          İletişim kayıtları için ayrıca yetki gerekir. Saatler İstanbul saatidir.
        </p>
      </details>
      {busy && <p role="status">İletişim bilgileri işleniyor…</p>}
      {error && <p role="alert">{error}</p>}
      {success && <p role="status">{success}</p>}
      {pending && (
        <Button variant="outline" disabled={busy || blocked} onClick={() => void send(pending)}>
          Aynı iletişim isteğini yeniden dene
        </Button>
      )}
      {needsRead ? (
        <Button variant="outline" disabled={busy} onClick={() => void load('readback')}>
          Kaydedilen iletişim geçmişini yeniden oku
        </Button>
      ) : (
        <Button variant="outline" disabled={busy || !!pending} onClick={() => void load('refresh')}>
          {mustRefresh ? 'Güncel iletişim bilgilerini karşılaştır' : 'İletişim geçmişini yenile'}
        </Button>
      )}
      {opened && (pending || busy || needsRead) && (
        <p>
          Görevden ayrılmak işlemi iptal etmez. Sonuç doğrulanmadan yeni kayıt göndermeyin; dönünce
          geçmişi yetkili okuyun. Anahtar yalnız açık bölümün belleğindedir.
        </p>
      )}
      {data && !blocked && (
        <>
          <dl className="today-task-facts">
            <div>
              <dt>Son doğrulanmış temas</dt>
              <dd>{interactionTime(data.lastContactAt) ?? 'Tarih bilgisi bulunmuyor'}</dd>
            </div>
            <div>
              <dt>Son temas denemesi</dt>
              <dd>{interactionTime(data.lastAttemptAt) ?? 'Tarih bilgisi bulunmuyor'}</dd>
            </div>
          </dl>
          <ul className="interaction-timeline" aria-label="İletişim geçmişi">
            {data.interactions.map((row) => (
              <li key={row.id}>
                <strong>
                  {interactionOutcomes[row.outcome ?? ''] ?? 'Sonuç bilgisi bulunmuyor'} —{' '}
                  {interactionChannels[row.channel ?? ''] ?? 'Kanal bilgisi bulunmuyor'}
                </strong>
                {interactionTime(row.occurred_at) ? (
                  <time dateTime={row.occurred_at!}>{interactionTime(row.occurred_at)}</time>
                ) : (
                  <p>Tarih bilgisi bulunmuyor</p>
                )}
                <p>Kaydeden: {row.author_name?.trim() || 'Çalışan adı mevcut değil'}</p>
                {typeof row.note === 'string' && row.note.trim() && (
                  <p className="interaction-note">{row.note}</p>
                )}
              </li>
            ))}
          </ul>
          {!data.interactions.length && <p>Henüz iletişim kaydı bulunmuyor.</p>}
          {!opened && !needsRead && (
            <Button
              disabled={locked}
              onClick={() => {
                setOpened(true);
                setOutcome('');
                setChannel('');
                setNote('');
                setContact('');
                setOccurred(localOccurrence(new Date().toISOString()));
                setComparison(false);
                setReconfirmed(false);
                setContactConfirmed(false);
                setError('');
                setSuccess('');
                onRiskChange('draft');
              }}
            >
              İletişim kaydı ekle
            </Button>
          )}
          {opened && (
            <form
              className="interaction-form"
              aria-label="Yeni iletişim kaydı"
              noValidate
              onSubmit={submit}
            >
              <h4 ref={formHeading} tabIndex={-1}>
                Yeni iletişim kaydı
              </h4>
              <p>
                Yanıtsız arama, WhatsApp işlemi veya yazılı not gerçek müşteri temasının kanıtı
                değildir. Bu form mesaj göndermez ve WhatsApp açmaz; WhatsApp açıldı kaydı yalnız
                ayrı önizleme/açma protokolündedir.
              </p>
              <fieldset disabled={locked}>
                <label htmlFor="interaction-outcome">Görüşme sonucu</label>
                <select
                  id="interaction-outcome"
                  value={outcome}
                  onChange={(event) => {
                    edited();
                    setOutcome(event.target.value as InteractionOutcome | '');
                    if (event.target.value === 'NOTE') setChannel('OTHER');
                  }}
                >
                  <option value="">Sonucu açıkça seçin</option>
                  {['CONTACT_CONFIRMED', 'ATTEMPT_NO_RESPONSE', 'NOTE'].map((value) => (
                    <option key={value} value={value}>
                      {interactionOutcomes[value]}
                    </option>
                  ))}
                </select>
                <label htmlFor="interaction-channel">İletişim kanalı</label>
                <select
                  id="interaction-channel"
                  value={channel}
                  disabled={outcome === 'NOTE'}
                  onChange={(event) => {
                    edited();
                    setChannel(event.target.value as InteractionChannel | '');
                  }}
                >
                  <option value="">Kanal seçin</option>
                  {Object.entries(interactionChannels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                {outcome === 'NOTE' && (
                  <p>İç not, Diğer kanalıyla kaydedilir; temas zamanını ilerletmez.</p>
                )}
                <label htmlFor="interaction-occurred">Gerçekleşme zamanı (İstanbul)</label>
                <Input
                  id="interaction-occurred"
                  type="datetime-local"
                  step="1"
                  value={occurred}
                  onChange={(event) => {
                    edited();
                    setOccurred(event.target.value);
                  }}
                />
                {data.customerType === 'COMPANY' && (
                  <>
                    <label htmlFor="interaction-contact">Şirket yetkilisi</label>
                    <select
                      id="interaction-contact"
                      value={contact}
                      onChange={(event) => {
                        edited();
                        setContact(event.target.value);
                      }}
                    >
                      <option value="">Yetkiliyi açıkça seçin</option>
                      {contact && !data.companyContacts.some((row) => row.id === contact) && (
                        <option value={contact} disabled>
                          Önceki seçim artık etkin seçeneklerde yok
                        </option>
                      )}
                      {data.companyContacts.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.displayName}
                          {row.role ? ' — ' + row.role : ''}
                        </option>
                      ))}
                    </select>
                    {!data.companyContacts.length && (
                      <p>
                        Etkin yetkili seçeneği yok; kayıt gönderilemez. Başka kişi otomatik
                        seçilmez.
                      </p>
                    )}
                  </>
                )}
                {outcome === 'NOTE' && (
                  <>
                    <label htmlFor="interaction-note">İç not</label>
                    <textarea
                      id="interaction-note"
                      maxLength={1000}
                      value={note}
                      onChange={(event) => {
                        edited();
                        setNote(event.target.value);
                      }}
                    />
                  </>
                )}
                {outcome === 'CONTACT_CONFIRMED' && (
                  <label className="interaction-confirm">
                    <input
                      type="checkbox"
                      checked={contactConfirmed}
                      onChange={(event) => setContactConfirmed(event.target.checked)}
                    />
                    Gerçek müşteri temasının gerçekleştiğini doğruluyorum
                  </label>
                )}
                {comparison && (
                  <>
                    <p role="status">
                      Güncel iletişim geçmişi ve yetkililer yeniden okundu. Taslağınız korundu;
                      seçim ve zamanı inceleyin.
                    </p>
                    <label className="interaction-confirm">
                      <input
                        type="checkbox"
                        checked={reconfirmed}
                        onChange={(event) => setReconfirmed(event.target.checked)}
                      />
                      Güncel bilgileri inceledim, taslağı yeniden göndermek istiyorum
                    </label>
                  </>
                )}
              </fieldset>
              <div className="interaction-actions">
                <Button type="submit" disabled={locked}>
                  İletişim kaydını kaydet
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !!pending || needsRead}
                  onClick={() => {
                    setOpened(false);
                    setMustRefresh(false);
                    setComparison(false);
                    setError('');
                    restoreFocus.current = true;
                    onRiskChange('clean');
                  }}
                >
                  Formu kapat ve taslağı bırak
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}

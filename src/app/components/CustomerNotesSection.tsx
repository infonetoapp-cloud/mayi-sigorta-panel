import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ApiResponse, CustomerNoteDto, CustomerNotesPage } from '../../shared/types';

interface Props {
  customerId: string;
  archived: boolean;
  getCsrfToken: () => Promise<string>;
  invalidateCsrfToken: () => void;
}
interface Attempt {
  body: string;
  key: string;
}
const formatter = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul',
  dateStyle: 'medium',
  timeStyle: 'short',
});

// The customer-keyed mount in App prevents drafts and pending results crossing profiles.
export function CustomerNotesSection({
  customerId,
  archived,
  getCsrfToken,
  invalidateCsrfToken,
}: Props) {
  const [opened, setOpened] = useState(false),
    [items, setItems] = useState<readonly CustomerNoteDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null),
    [canCreate, setCanCreate] = useState(false);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState(false),
    [failedCursor, setFailedCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState(''),
    [writeError, setWriteError] = useState(''),
    [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState<Attempt | null>(null);
  const attempt = useRef<Attempt | null>(null),
    saving = useRef(false),
    generation = useRef(0),
    readRequest = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      readRequest.current++;
    },
    [],
  );
  const url = `/api/customers/${encodeURIComponent(customerId)}/notes`;
  async function load(after: string | null) {
    const request = ++readRequest.current,
      view = generation.current;
    setOpened(true);
    setLoading(true);
    setReadError(false);
    try {
      const response = await fetch(`${url}${after ? `?cursor=${encodeURIComponent(after)}` : ''}`, {
        cache: 'no-store',
      });
      if (view !== generation.current || request !== readRequest.current) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        setItems([]);
        setCursor(null);
        setCanCreate(false);
      }
      if (!response.ok) throw new Error('READ_FAILED');
      const result = (await response.json()) as ApiResponse<CustomerNotesPage>;
      if (view !== generation.current || request !== readRequest.current) return;
      if (!result.success) throw new Error('READ_FAILED');
      setItems((previous) =>
        after
          ? [
              ...new Map(
                [...previous, ...result.data.items].map((note) => [note.id, note]),
              ).values(),
            ]
          : result.data.items,
      );
      setCursor(result.data.nextCursor);
      setCanCreate(result.data.canCreate);
    } catch {
      if (view === generation.current && request === readRequest.current) {
        setReadError(true);
        setFailedCursor(after);
      }
    } finally {
      if (view === generation.current && request === readRequest.current) setLoading(false);
    }
  }
  async function send(current: Attempt) {
    if (saving.current || archived || !canCreate) return;
    saving.current = true;
    setBusy(true);
    setWriteError('');
    setSaved(false);
    setRetry(null);
    const view = generation.current;
    try {
      let response: Response | null = null;
      for (let index = 0; index < 2; index++) {
        const token = await getCsrfToken();
        if (view !== generation.current) return;
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
            'Idempotency-Key': current.key,
          },
          body: current.body,
        });
        const result = (await response
          .clone()
          .json()
          .catch(() => null)) as { error?: { code?: string } } | null;
        if (view !== generation.current) return;
        if (response.status === 403 && index === 0 && result?.error?.code?.startsWith('CSRF_')) {
          invalidateCsrfToken();
          continue;
        }
        break;
      }
      if (!response) throw new Error('UNCERTAIN');
      if (!response.ok) {
        if (response.status >= 500 || response.status === 429) throw new Error('UNCERTAIN');
        attempt.current = null;
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          setCanCreate(false);
          setItems([]);
          setCursor(null);
          setWriteError(
            'Açık müşteri kaydı veya not ekleme yetkisi artık kullanılamıyor. Notlar yenilenmeli.',
          );
        } else
          setWriteError(
            response.status === 409
              ? 'Not isteği çakıştı. Notları yenileyip kontrol edin.'
              : 'Not kaydedilemedi. İçeriği kontrol edin (en fazla 2000 karakter).',
          );
        return;
      }
      const envelope = (await response.json()) as ApiResponse<CustomerNoteDto>;
      if (view !== generation.current) return;
      if (!envelope.success) throw new Error('UNCERTAIN');
      attempt.current = null;
      setDraft('');
      setSaved(true);
      await load(null);
    } catch {
      if (view !== generation.current) return;
      setWriteError(
        'Notun kaydedildiği doğrulanamadı. Aynı notu güvenle yeniden deneyebilirsiniz.',
      );
      setRetry(current);
    } finally {
      saving.current = false;
      if (view === generation.current) setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || content.length > 2000 || archived || !canCreate) return;
    const body = JSON.stringify({ content });
    const current =
      attempt.current?.body === body ? attempt.current : { body, key: crypto.randomUUID() };
    attempt.current = current;
    void send(current);
  }
  return (
    <section aria-label="Müşteri Notları" style={{ display: 'grid', gap: '0.75rem' }}>
      <h3>Müşteri Notları</h3>
      <p>
        Müşteriye ait ortak notlar; yenileme görüşmelerinden ve özel günlük görevlerden bağımsızdır.
        Kimlik numarası, sağlık bilgisi veya parola yazmayın.
      </p>
      {!opened ? (
        <button type="button" onClick={() => void load(null)}>
          Notları göster
        </button>
      ) : (
        <button type="button" disabled={loading || busy} onClick={() => void load(null)}>
          Notları yenile
        </button>
      )}
      {loading && <p role="status">Notlar yükleniyor…</p>}
      {readError && (
        <p role="alert">
          Notlar okunamadı.{' '}
          <button type="button" disabled={loading || busy} onClick={() => void load(failedCursor)}>
            Aynı not sayfasını yeniden dene
          </button>
        </p>
      )}
      {saved && <p role="status">Not kaydedildi.</p>}
      {writeError && <p role="alert">{writeError}</p>}
      {canCreate && !archived && (
        <form onSubmit={submit} style={{ display: 'grid', gap: '0.5rem' }}>
          <label htmlFor={`customer-note-${customerId}`}>Yeni müşteri notu</label>
          <textarea
            id={`customer-note-${customerId}`}
            value={draft}
            maxLength={2000}
            required
            disabled={busy}
            rows={4}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
              setRetry(null);
              setWriteError('');
            }}
          />
          <small>
            {draft.length}/2000 karakter · Kaydedilen not değiştirilemez veya silinemez.
          </small>
          <button type="submit" disabled={busy || !draft.trim() || draft.length > 2000}>
            {busy ? 'Kaydediliyor…' : 'Notu kaydet'}
          </button>
          {retry && (
            <button type="button" disabled={busy} onClick={() => void send(retry)}>
              Aynı notu yeniden dene
            </button>
          )}
        </form>
      )}
      {archived && <p>Arşivlenmiş müşteriye yeni not eklenemez.</p>}
      {opened && !loading && !readError && !items.length && <p>Henüz müşteri notu yok.</p>}
      {!!items.length && (
        <>
          <small>En yeni not önce · Türkiye saati</small>
          <ol aria-label="Müşteri not geçmişi">
            {items.map((note) => (
              <li key={note.id} style={{ marginBottom: '1rem' }}>
                <p>Kaydeden: {note.authorName || 'Çalışan adı mevcut değil'}</p>
                <time dateTime={note.createdAt}>{formatter.format(new Date(note.createdAt))}</time>
                <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{note.content}</p>
              </li>
            ))}
          </ol>
        </>
      )}
      {cursor && !readError && (
        <button type="button" disabled={loading || busy} onClick={() => void load(cursor)}>
          Daha eski notlar
        </button>
      )}
    </section>
  );
}

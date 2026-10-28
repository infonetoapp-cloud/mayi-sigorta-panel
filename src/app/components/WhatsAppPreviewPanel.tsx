import { useEffect, useRef, useState } from 'react';

interface Preview {
  phone: string;
  message: string;
  companyContactId: string | null;
  expectedRenewalVersion: number;
}
interface Props {
  readonly renewalId: string;
  readonly companyContactId: string | null;
  readonly contactRequired: boolean;
  readonly getCsrfToken: () => Promise<string>;
  readonly invalidateCsrfToken: () => void;
  readonly onOpened: () => void;
  readonly onRiskChange?: (risk: 'clean' | 'draft' | 'uncertain') => void;
}

class WhatsAppResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function readResponse(response: Response): Promise<unknown> {
  const envelope = (await response.json()) as {
    success?: boolean;
    data?: unknown;
    error?: { code?: string };
  };
  if (!response.ok || envelope.success !== true) {
    const code = envelope.error?.code;
    if (code === 'WHATSAPP_PHONE_REQUIRED' || code === 'WHATSAPP_PHONE_INVALID')
      throw new WhatsAppResponseError(
        response.status,
        'Telefon eksik veya geçersiz. Müşteri/şirket yetkilisinin iletişim bilgisini tamamlayın.',
      );
    if (code === 'CSRF_OR_IDEMPOTENCY_INVALID')
      throw new WhatsAppResponseError(
        response.status,
        'Güvenlik doğrulaması yenilenmeli. Tekrar deneyin.',
      );
    if (response.status === 403 || response.status === 404)
      throw new WhatsAppResponseError(response.status, 'Bu yenileme kaydına erişilemiyor.');
    if (response.status === 409)
      throw new WhatsAppResponseError(response.status, 'Kayıt değişti. Önizlemeyi yenileyin.');
    throw new WhatsAppResponseError(response.status, 'İşlem tamamlanamadı. Tekrar deneyin.');
  }
  return envelope.data;
}

export function WhatsAppPreviewPanel({
  renewalId,
  companyContactId,
  contactRequired,
  getCsrfToken,
  invalidateCsrfToken,
  onOpened,
  onRiskChange,
}: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const live = useRef(true);
  const popup = useRef<Window | null>(null);
  const [pending, setPending] = useState<{
    body: string;
    key: string;
    preview: Preview;
    message: string;
  } | null>(null);
  const lock = useRef(false);
  const riskCallback = useRef(onRiskChange);
  riskCallback.current = onRiskChange;
  useEffect(() => {
    riskCallback.current?.(pending || busy ? 'uncertain' : preview ? 'draft' : 'clean');
  }, [pending, busy, preview]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      popup.current?.close();
      popup.current = null;
    };
  }, []);
  const base = `/api/renewals/${encodeURIComponent(renewalId)}`;

  async function loadPreview() {
    if (lock.current || pending) return;
    lock.current = true;
    riskCallback.current?.('uncertain');
    setBusy(true);
    setError(null);
    setMessage(null);
    setPreview(null);
    try {
      const query = companyContactId ? `?${new URLSearchParams({ companyContactId })}` : '';
      const data = (await readResponse(
        await fetch(`${base}/whatsapp-preview${query}`, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
        }),
      )) as Preview;
      if (!live.current) return;
      if (
        !data ||
        !/^[1-9]\d{7,14}$/.test(data.phone) ||
        typeof data.message !== 'string' ||
        data.message.length < 1 ||
        data.message.length > 1000 ||
        data.companyContactId !== companyContactId ||
        !Number.isSafeInteger(data.expectedRenewalVersion) ||
        data.expectedRenewalVersion < 1
      )
        throw new Error('Önizleme okunamadı.');
      setPreview(data);
      setDraft(data.message);
    } catch (caught) {
      if (live.current)
        setError(caught instanceof Error ? caught.message : 'Önizleme yüklenemedi.');
    } finally {
      if (live.current) {
        setBusy(false);
        lock.current = false;
      }
    }
  }

  async function openWhatsApp() {
    if (!preview || busy || lock.current) return;
    // Reserve a tab in the explicit user gesture; blocked popups do not record an open.
    const tab = open('', '_blank');
    if (!tab) {
      setError('WhatsApp için açılır pencereye izin verin ve tekrar deneyin.');
      return;
    }
    tab.opener = null;
    popup.current = tab;
    lock.current = true;
    riskCallback.current?.('uncertain');
    setBusy(true);
    setError(null);
    setMessage(null);
    const initialBody = JSON.stringify({
      companyContactId: preview.companyContactId,
      expectedPhone: preview.phone,
      expectedRenewalVersion: preview.expectedRenewalVersion,
      message: draft,
    });
    const attempt = pending ?? {
      body: initialBody,
      key: crypto.randomUUID(),
      preview: structuredClone(preview),
      message: draft,
    };
    const { body, key } = attempt;
    const wasUncertain = pending !== null;
    let transmitted = false;
    setPending(attempt);
    try {
      const token = await getCsrfToken();
      if (!live.current) {
        tab.close();
        return;
      }
      transmitted = true;
      const data = (await readResponse(
        await fetch(`${base}/whatsapp-open`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
            'Idempotency-Key': key,
          },
          body,
        }),
      )) as { outcome?: string; url?: string };
      if (!live.current) {
        tab.close();
        return;
      }
      if (!data || data.outcome !== 'WHATSAPP_OPENED' || typeof data.url !== 'string')
        throw new Error('İşlem sonucu okunamadı.');
      const target = new URL(data.url);
      if (
        target.origin !== 'https://wa.me' ||
        target.pathname !== `/${attempt.preview.phone}` ||
        target.username ||
        target.password ||
        target.hash ||
        [...target.searchParams.keys()].length !== 1 ||
        target.searchParams.get('text') !== attempt.message
      )
        throw new Error('WhatsApp bağlantısı doğrulanamadı.');
      tab.location.replace(target.href);
      popup.current = null;
      setPending(null);
      setPreview(null);
      setDraft('');
      riskCallback.current?.('clean');
      setMessage('WhatsApp açma aksiyonu kaydedildi; gönderildi veya gerçek temas sayılmaz.');
      onOpened();
    } catch (caught) {
      tab.close();
      popup.current = null;
      if (live.current) {
        if (
          !wasUncertain &&
          (!transmitted ||
            (caught instanceof WhatsAppResponseError &&
              [400, 401, 403, 404, 409, 422].includes(caught.status)))
        )
          setPending(null);
        const text = caught instanceof Error ? caught.message : 'WhatsApp açılamadı.';
        setError(text);
        if (text.includes('Güvenlik doğrulaması')) invalidateCsrfToken();
      }
    } finally {
      if (live.current) {
        setBusy(false);
        lock.current = false;
      }
    }
  }

  return (
    <section aria-label="WhatsApp önizleme">
      <h4>WhatsApp taslağı</h4>
      <p>
        Önizleme temas kaydı oluşturmaz. Açmak gönderildi/teslim edildi demek değildir. Gerçek
        teması ayrı iletişim kaydıyla doğrulayın.
      </p>
      <button
        type="button"
        disabled={busy || !!pending || (contactRequired && !companyContactId)}
        onClick={() => void loadPreview()}
      >
        WhatsApp önizle
      </button>
      {contactRequired && !companyContactId && <p>Önce şirket iletişim kişisini seçin.</p>}
      {preview && (
        <>
          <p>Telefon: +{preview.phone}</p>
          <label>
            WhatsApp taslağı
            <textarea
              aria-label="WhatsApp taslağı"
              disabled={busy || !!pending}
              value={draft}
              maxLength={1000}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <p>
            TCKN, sağlık detayı, belge erişim anahtarı veya sır eklemeyin. Serbest metin otomatik
            olarak hassas veriden arındırılmaz.
          </p>
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() => void openWhatsApp()}
          >
            WhatsApp aç
          </button>
          <button
            type="button"
            disabled={busy || !!pending}
            onClick={() => {
              setPreview(null);
              setDraft('');
              setError(null);
              riskCallback.current?.('clean');
            }}
          >
            Taslağı kapat
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

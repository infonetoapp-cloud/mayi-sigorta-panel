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
      throw new Error(
        'Telefon eksik veya geçersiz. Müşteri/şirket yetkilisinin iletişim bilgisini tamamlayın.',
      );
    if (code === 'CSRF_OR_IDEMPOTENCY_INVALID')
      throw new Error('CSRF doğrulaması yenilenmeli. Tekrar deneyin.');
    if (response.status === 403 || response.status === 404)
      throw new Error('Bu yenileme kaydına erişilemiyor.');
    if (response.status === 409) throw new Error('Kayıt değişti. Önizlemeyi yenileyin.');
    throw new Error('İşlem tamamlanamadı. Tekrar deneyin.');
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
}: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const live = useRef(true);
  const popup = useRef<Window | null>(null);
  const attempts = useRef(new Map<string, string>());
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
      if (live.current) setBusy(false);
    }
  }

  async function openWhatsApp() {
    if (!preview || busy) return;
    // Reserve a tab in the explicit user gesture; blocked popups do not record an open.
    const tab = open('', '_blank');
    if (!tab) {
      setError('WhatsApp için açılır pencereye izin verin ve tekrar deneyin.');
      return;
    }
    tab.opener = null;
    popup.current = tab;
    setBusy(true);
    setError(null);
    setMessage(null);
    const body = JSON.stringify({
      companyContactId: preview.companyContactId,
      expectedPhone: preview.phone,
      expectedRenewalVersion: preview.expectedRenewalVersion,
      message: draft,
    });
    const key = attempts.current.get(body) ?? crypto.randomUUID();
    attempts.current.set(body, key);
    try {
      const token = await getCsrfToken();
      if (!live.current) {
        tab.close();
        return;
      }
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
        target.pathname !== `/${preview.phone}` ||
        target.username ||
        target.password ||
        target.hash ||
        [...target.searchParams.keys()].length !== 1 ||
        target.searchParams.get('text') !== draft
      )
        throw new Error('WhatsApp bağlantısı doğrulanamadı.');
      tab.location.replace(target.href);
      popup.current = null;
      attempts.current.delete(body);
      setMessage('WhatsApp açma aksiyonu kaydedildi; gönderildi veya gerçek temas sayılmaz.');
      onOpened();
    } catch (caught) {
      tab.close();
      popup.current = null;
      if (live.current) {
        const text = caught instanceof Error ? caught.message : 'WhatsApp açılamadı.';
        setError(text);
        if (text.includes('CSRF')) invalidateCsrfToken();
      }
    } finally {
      if (live.current) setBusy(false);
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
        disabled={busy || (contactRequired && !companyContactId)}
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
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { EmployeeDocumentDto } from '../../shared/document-types';
import {
  DocumentProductError,
  readEmployeeDocuments,
  uploadEmployeeDocument,
  downloadEmployeeDocument,
  documentPost,
  saveDocumentAttachment,
  type UploadAttempt,
} from '../documents-api';
import { ReauthForm } from '../AuthShell';
const confirmationSchema = z
  .object({
    documentId: z.string(),
    expectedVersion: z.number().int().positive(),
    versionId: z.string(),
    checksum: z.string().regex(/^[0-9a-f]{64}$/u),
    classification: z.enum(['GENERAL', 'IDENTITY', 'HEALTH']),
    parentHealth: z.boolean(),
    confirmationText: z.string().min(1).max(1000),
  })
  .strict();
type Confirmation = z.infer<typeof confirmationSchema>;
export function DocumentSection({
  ownerType,
  ownerId,
}: {
  ownerType: 'CUSTOMER' | 'POLICY' | 'QUOTE';
  ownerId: string;
}) {
  const [rows, setRows] = useState<EmployeeDocumentDto[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [file, setFile] = useState<File | null>(null),
    [classification, setClassification] = useState<UploadAttempt['classification']>('GENERAL'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [note, setNote] = useState(''),
    [retry, setRetry] = useState<UploadAttempt | null>(null),
    [retryAt, setRetryAt] = useState(0),
    [clock, setClock] = useState(Date.now()),
    [reauth, setReauth] = useState<string | null>(null),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [available, setAvailable] = useState(false);
  const generation = useRef(0),
    loadSequence = useRef(0),
    lock = useRef(false);
  const safeError = (e: unknown) =>
    e instanceof DocumentProductError
      ? e.message
      : 'Belge işlemi tamamlanamadı. Lütfen tekrar deneyin veya yöneticinizle görüşün.';
  async function load(next?: string) {
    const g = generation.current,
      s = ++loadSequence.current;
    try {
      const page = await readEmployeeDocuments(ownerType, ownerId, next);
      if (g !== generation.current || s !== loadSequence.current) return;
      setRows((prev) => (next ? [...prev, ...page.documents] : page.documents));
      setCursor(page.nextCursor);
      setAvailable(true);
      setError('');
    } catch (e) {
      if (g === generation.current && s === loadSequence.current) {
        if (e instanceof DocumentProductError && [401, 403, 404].includes(e.status)) {
          generation.current++;
          loadSequence.current++;
          setRows([]);
          setCursor(null);
          setAvailable(false);
          setFile(null);
          setRetry(null);
          setConfirmation(null);
          setReauth(null);
          setNote('');
          setBusy(false);
          lock.current = false;
        }
        setError(e instanceof DocumentProductError && e.status === 404 ? '' : safeError(e));
      }
    }
  }
  useEffect(() => {
    generation.current++;
    setRows([]);
    setAvailable(false);
    setCursor(null);
    setRetry(null);
    setFile(null);
    setConfirmation(null);
    setReauth(null);
    setError('');
    setNote('');
    lock.current = false;
    setBusy(false);
    void load();
    return () => {
      generation.current++;
      loadSequence.current++;
    };
  }, [ownerType, ownerId]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function upload(attempt: UploadAttempt) {
    if (lock.current) return;
    const g = generation.current;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await uploadEmployeeDocument(attempt);
      if (g !== generation.current) return;
      setRetry(null);
      setFile(null);
      setNote('Yükleme alındı; belge işleniyor.');
      await load();
    } catch (e) {
      if (g !== generation.current) return;
      setError(safeError(e));
      setRetry(!(e instanceof DocumentProductError) || e.retryable ? attempt : null);
      setRetryAt(
        e instanceof DocumentProductError && e.waitSeconds > 0
          ? Date.now() + e.waitSeconds * 1000
          : 0,
      );
    } finally {
      if (g === generation.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  async function normal(id: string) {
    if (lock.current) return;
    const g = generation.current;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const blob = await downloadEmployeeDocument(id);
      if (g !== generation.current) return;
      saveDocumentAttachment(blob);
      setNote('İndirme başlatıldı.');
    } catch (e) {
      if (g === generation.current) setError(safeError(e));
    } finally {
      if (g === generation.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  async function prepare(id: string) {
    const g = generation.current;
    setReauth(null);
    setBusy(true);
    try {
      const r = await documentPost(
        '/secure/api/documents/' + encodeURIComponent(id) + '/download-confirmation',
        {},
      );
      const p = (await r.json()) as { data: unknown };
      const c = confirmationSchema.parse(p.data);
      if (c.documentId !== id) throw Error('identity');
      if (g === generation.current) setConfirmation(c);
    } catch (e) {
      if (g === generation.current) setError(safeError(e));
    } finally {
      if (g === generation.current) setBusy(false);
    }
  }
  async function sensitive() {
    if (!confirmation || lock.current) return;
    const c = structuredClone(confirmation),
      g = generation.current;
    setConfirmation(null);
    lock.current = true;
    setBusy(true);
    try {
      const body = {
        expectedVersion: c.expectedVersion,
        versionId: c.versionId,
        checksum: c.checksum,
        confirmation: 'DOWNLOAD_SENSITIVE_DOCUMENT',
      };
      const r = await documentPost(
        '/secure/api/documents/' + encodeURIComponent(c.documentId) + '/download-grants',
        body,
        crypto.randomUUID(),
      );
      const p = (await r.json()) as { data?: { grantEvidenceToken?: string } };
      const token = p.data?.grantEvidenceToken;
      if (!token || !/^[0-9a-f]{64}$/u.test(token)) throw Error('grant');
      if (g !== generation.current) return;
      const blob = await downloadEmployeeDocument(
        c.documentId,
        { ...body, grantEvidenceToken: token },
        true,
      );
      if (g === generation.current) {
        saveDocumentAttachment(blob);
        setNote('İndirme başlatıldı.');
      }
    } catch (e) {
      if (g === generation.current)
        setError(safeError(e) + ' Hassas indirme için yeniden onay verin.');
    } finally {
      if (g === generation.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  if (!available)
    return error ? (
      <section aria-label="Belgeler">
        <p role="alert">{error}</p>
        <button type="button" onClick={() => void load()}>
          Listeyi yenile
        </button>
      </section>
    ) : null;
  return (
    <section aria-label="Belgeler">
      <h3>Belgeler</h3>
      <p>
        PDF, JPEG veya PNG · En fazla 20 MiB. İçerik yapısı doğrulanır; virüs taraması yapıldığı
        anlamına gelmez.
      </p>
      <button type="button" disabled={busy} onClick={() => void load()}>
        Listeyi yenile
      </button>
      {error && <p role="alert">{error}</p>}
      {note && <p role="status">{note}</p>}
      {!rows.length && !error && <p>Bu kayıtta görünür belge yok.</p>}
      <ul>
        {rows.map((row) => (
          <li key={row.documentId}>
            <span>{row.fileName}</span> ·{' '}
            <span>
              {row.status === 'READY'
                ? 'İndirmeye hazır'
                : row.status === 'FAILED'
                  ? 'İşlem tamamlanamadı; yöneticinizle görüşün.'
                  : 'İşleniyor'}
            </span>{' '}
            <button
              type="button"
              disabled={busy || row.status !== 'READY'}
              onClick={() =>
                row.downloadMode === 'SENSITIVE'
                  ? setReauth(row.documentId)
                  : void normal(row.documentId)
              }
            >
              İndir
            </button>
          </li>
        ))}
      </ul>
      {cursor && (
        <button type="button" disabled={busy} onClick={() => void load(cursor)}>
          Daha fazla belge
        </button>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!file || busy || retry) return;
          if (
            !['application/pdf', 'image/jpeg', 'image/png'].includes(file.type) ||
            file.size < 1 ||
            file.size > 20971520
          ) {
            setError('Desteklenen PDF/JPEG/PNG dosyası seçin; sınır 20 MiB.');
            return;
          }
          void upload({ ownerType, ownerId, classification, file, key: crypto.randomUUID() });
        }}
      >
        <label>
          Dosya
          <input
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            disabled={busy || !!retry}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <label>
          Belge sınıfı
          <select
            value={classification}
            disabled={busy || !!retry}
            onChange={(e) => setClassification(e.target.value as UploadAttempt['classification'])}
          >
            <option value="GENERAL">Genel</option>
            <option value="IDENTITY">Kimlik</option>
            <option value="HEALTH">Sağlık</option>
          </select>
        </label>
        <button type="submit" disabled={!file || busy || !!retry}>
          Belge yükle
        </button>
      </form>
      {retry && (
        <div>
          <button
            type="button"
            disabled={busy || clock < retryAt}
            onClick={() => void upload(retry)}
          >
            Yüklemeyi tekrar dene
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setRetry(null);
              setFile(null);
              setError('');
            }}
          >
            Yüklemeyi iptal et
          </button>
        </div>
      )}
      {reauth && (
        <ReauthForm onSuccess={() => void prepare(reauth)} onCancel={() => setReauth(null)} />
      )}
      {confirmation && (
        <div role="dialog" aria-modal="true" aria-label="Hassas belge indirme onayı">
          <p>{confirmation.confirmationText}</p>
          <button type="button" disabled={busy} onClick={() => void sensitive()}>
            Onaylıyorum, indir
          </button>
          <button type="button" onClick={() => setConfirmation(null)}>
            Vazgeç
          </button>
        </div>
      )}
    </section>
  );
}

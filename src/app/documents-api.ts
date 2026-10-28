import { z } from 'zod';
import type { EmployeeDocumentPage } from '../shared/document-types';
export class DocumentProductError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly waitSeconds = 0,
    message = 'Belge işlemi tamamlanamadı. Lütfen tekrar deneyin veya yöneticinizle görüşün.',
    readonly status = 0,
  ) {
    super(message);
  }
}
async function checked(response: Response) {
  if (response.ok) return response;
  let code = '';
  try {
    const p = (await response.json()) as { error?: { code?: string } };
    code = p.error?.code ?? '';
  } catch {
    /* Never display raw server/provider content. */
  }
  const retry =
    response.status === 503 ||
    response.status === 429 ||
    (response.status === 409 && code === 'IDEMPOTENCY_IN_PROGRESS');
  const messages: Record<number, string> = {
    401: 'Oturum veya güncel şifre doğrulaması gerekli.',
    403: 'Bu belge işlemi için yetkiniz bulunmuyor.',
    404: 'Belge veya bağlı kayıt kullanılamıyor.',
    413: 'Dosya 20 MiB sınırını aşıyor.',
    415: 'Yalnız desteklenen PDF, JPEG ve PNG dosyaları yüklenebilir.',
    429: 'Çok sayıda işlem denendi. Bir dakika sonra tekrar deneyin.',
  };
  const seconds = Number(
    response.headers.get('Retry-After') ?? (response.status === 429 ? '60' : '0'),
  );
  throw new DocumentProductError(
    retry,
    Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 3600 ? seconds : 60,
    messages[response.status],
    response.status,
  );
}
async function csrf() {
  const r = await checked(await fetch('/api/auth/csrf-token', { cache: 'no-store' }));
  const p = (await r.json()) as { data?: { token?: string } };
  if (!p.data?.token) throw new DocumentProductError(false);
  return p.data.token;
}
export async function documentPost(path: string, body: unknown, key?: string) {
  return checked(
    await fetch(path, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': await csrf(),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}
export async function readEmployeeDocuments(
  ownerType: string,
  ownerId: string,
  cursor?: string,
): Promise<EmployeeDocumentPage> {
  const q = new URLSearchParams({ ownerType, ownerId, ...(cursor ? { cursor } : {}) });
  const r = await checked(await fetch('/api/documents?' + q, { cache: 'no-store' }));
  const p = (await r.json()) as { data?: unknown };
  return z
    .object({
      documents: z
        .array(
          z
            .object({
              documentId: z.string().min(1),
              fileName: z.string().max(1024),
              classification: z.enum(['GENERAL', 'IDENTITY', 'HEALTH']),
              status: z.enum(['PROCESSING', 'READY', 'FAILED']),
              createdAt: z.string(),
              sizeBytes: z.number().int().positive().max(20971520),
              downloadMode: z.enum(['NORMAL', 'SENSITIVE']),
            })
            .strict(),
        )
        .max(20),
      nextCursor: z.string().max(1024).nullable(),
    })
    .strict()
    .parse(p.data);
}
export interface UploadAttempt {
  readonly ownerType: 'CUSTOMER' | 'POLICY' | 'QUOTE';
  readonly ownerId: string;
  readonly classification: 'GENERAL' | 'IDENTITY' | 'HEALTH';
  readonly file: File;
  readonly key: string;
}
export async function uploadEmployeeDocument(a: UploadAttempt) {
  const body = new FormData();
  body.set('ownerType', a.ownerType);
  body.set('ownerId', a.ownerId);
  body.set('classification', a.classification);
  body.set('file', a.file);
  await checked(
    await fetch('/api/documents', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'X-CSRF-Token': await csrf(), 'Idempotency-Key': a.key },
      body,
    }),
  );
}
export async function downloadEmployeeDocument(id: string, body: unknown = {}, secure = false) {
  const r = await documentPost(
    (secure ? '/secure' : '') + '/api/documents/' + encodeURIComponent(id) + '/download',
    body,
  );
  return r.blob();
}
export function saveDocumentAttachment(blob: Blob) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download =
    blob.type === 'image/png'
      ? 'document.png'
      : blob.type === 'image/jpeg'
        ? 'document.jpg'
        : 'document.pdf';
  link.rel = 'noreferrer';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

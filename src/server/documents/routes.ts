import type { Context, Hono } from 'hono';
import { API_PREFIX } from '../../shared/constants';
import { AccessConfigError, parseAccessConfig } from '../auth/config';
import { AccessVerificationError } from '../auth/errors';
import { createAccessVerifier } from '../auth/verifier';
import { createApplicationIdentityResolver, IdentityResolutionError } from '../auth/identity';
import { parseCsrfConfig } from '../config';
import { IdempotencyConflictError } from '../mutations/idempotency';
import { verifyCsrfMutationGuard } from '../security/csrf';
import { MAX_DOCUMENT_UPLOAD_BYTES } from './validation';
import { createDocumentUpload, DocumentUploadError } from './service';
import type { AppDependencies, Env } from '../index';
import { registerDocumentStreamRoutes } from './stream-routes';

type DocumentRouteEnv = { Bindings: Env };

async function readBoundedBody(request: Request): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const maximumRequestBytes = MAX_DOCUMENT_UPLOAD_BYTES + 65_536;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumRequestBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DocumentUploadError('VALIDATION_ERROR', 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DocumentUploadError) throw error;
    throw new DocumentUploadError('SERVICE_UNAVAILABLE', 503);
  }

  const boundedBody = new ArrayBuffer(totalBytes);
  const boundedView = new Uint8Array(boundedBody);
  let offset = 0;
  for (const chunk of chunks) {
    boundedView.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return boundedBody;
}

function errorResponse(
  c: Context<DocumentRouteEnv>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500 | 503,
  code: string,
  message: string,
) {
  c.header('Cache-Control', 'private, no-store');
  return c.json(
    { success: false, error: { code, message }, timestamp: new Date().toISOString() },
    status,
  );
}

function isAccessInfrastructureError(error: unknown): boolean {
  if (error instanceof AccessConfigError) return true;
  if (error instanceof IdentityResolutionError) return error.code === 'DATABASE_ERROR';
  return (
    error instanceof AccessVerificationError &&
    (error.code === 'JWKS_FETCH_FAILED' || error.code === 'CONFIGURATION_ERROR')
  );
}

export function registerDocumentRoutes(
  app: Hono<DocumentRouteEnv>,
  dependencies: AppDependencies = {},
): void {
  registerDocumentStreamRoutes(app, dependencies);
  app.post(`${API_PREFIX}/documents`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    if (c.env.DOCUMENTS_ENABLED !== 'true') {
      return errorResponse(c, 404, 'NOT_FOUND', 'Bilinmeyen API uç noktası.');
    }
    if (!c.env.DB)
      return errorResponse(c, 503, 'SERVICE_UNAVAILABLE', 'Veritabanı kullanılamıyor.');
    if (!c.env.DOCS_QUARANTINE) {
      return errorResponse(c, 503, 'SERVICE_UNAVAILABLE', 'Belge karantina alanı kullanılamıyor.');
    }

    let principal;
    let context;
    try {
      const accessConfig = parseAccessConfig(c.env);
      const verifier = dependencies.createVerifier
        ? dependencies.createVerifier(accessConfig)
        : createAccessVerifier({ config: accessConfig });
      principal = await verifier.verify(c.req.raw);
      const resolver = dependencies.createResolver
        ? dependencies.createResolver(c.env.DB)
        : createApplicationIdentityResolver(c.env.DB);
      context = await resolver.resolve(principal);
    } catch (error) {
      const status = isAccessInfrastructureError(error) ? 503 : 401;
      return errorResponse(
        c,
        status,
        status === 503 ? 'SERVICE_UNAVAILABLE' : 'UNAUTHORIZED',
        status === 503 ? 'Kimlik doğrulama altyapısı kullanılamıyor.' : 'Kimlik doğrulanamadı.',
      );
    }

    let csrfAllowed: boolean;
    try {
      const result = await verifyCsrfMutationGuard(c.req.raw, {
        authenticatedSubject: principal.subject,
        secret: parseCsrfConfig(c.env).CSRF_SECRET,
      });
      csrfAllowed = result.allowed;
    } catch {
      csrfAllowed = false;
    }
    if (!csrfAllowed) {
      return errorResponse(c, 403, 'FORBIDDEN', 'CSRF doğrulaması başarısız oldu.');
    }

    const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
    if (!idempotencyKey) {
      return errorResponse(c, 400, 'VALIDATION_ERROR', 'Idempotency-Key zorunludur.');
    }

    const contentType = c.req.header('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('multipart/form-data;')) {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE', 'multipart/form-data zorunludur.');
    }
    const contentLength = c.req.header('content-length');
    if (contentLength !== undefined) {
      const parsedLength = Number(contentLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
        return errorResponse(c, 400, 'VALIDATION_ERROR', 'İstek boyutu geçersiz.');
      }
      if (parsedLength > MAX_DOCUMENT_UPLOAD_BYTES + 65_536) {
        return errorResponse(c, 413, 'SIZE_LIMIT', 'Belge boyutu izin verilen sınırı aşıyor.');
      }
    }

    let formData: FormData;
    try {
      const boundedBody = await readBoundedBody(c.req.raw);
      const boundedRequest = new Request(c.req.url, {
        method: 'POST',
        headers: c.req.raw.headers,
        body: boundedBody,
      });
      formData = await boundedRequest.formData();
    } catch (error) {
      if (error instanceof DocumentUploadError) {
        return errorResponse(c, error.status, error.code, uploadErrorMessage(error));
      }
      return errorResponse(c, 400, 'VALIDATION_ERROR', 'Geçersiz multipart isteği.');
    }

    const allowedFields = new Set(['ownerType', 'ownerId', 'classification', 'file']);
    const seenFields = new Set<string>();
    for (const [name] of formData.entries()) {
      if (!allowedFields.has(name) || seenFields.has(name)) {
        return errorResponse(c, 400, 'VALIDATION_ERROR', 'Belge isteği alanları geçersiz.');
      }
      seenFields.add(name);
    }
    if (seenFields.size !== allowedFields.size) {
      return errorResponse(c, 400, 'VALIDATION_ERROR', 'Belge isteği alanları eksik.');
    }

    const ownerType = formData.get('ownerType');
    const ownerId = formData.get('ownerId');
    const classification = formData.get('classification');
    const file = formData.get('file');
    if (
      typeof ownerType !== 'string' ||
      typeof ownerId !== 'string' ||
      typeof classification !== 'string' ||
      !(file instanceof File)
    ) {
      return errorResponse(c, 400, 'VALIDATION_ERROR', 'Belge isteği alanları geçersiz.');
    }

    try {
      const result = await createDocumentUpload(
        c.env.DB,
        c.env.DOCS_QUARANTINE,
        context,
        {
          ownerType,
          ownerId,
          classification,
          fileName: file.name,
          declaredContentType: file.type,
          file,
        },
        { correlationId: crypto.randomUUID(), idempotencyKey },
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(
        {
          success: true,
          data: result.body,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        result.status,
      );
    } catch (error) {
      if (error instanceof DocumentUploadError) {
        return errorResponse(c, error.status, error.code, uploadErrorMessage(error));
      }
      if (error instanceof IdempotencyConflictError) {
        return errorResponse(c, 409, 'IDEMPOTENCY_CONFLICT', 'İşlem anahtarı çakıştı.');
      }
      if (error instanceof IdentityResolutionError) {
        return errorResponse(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
      }
      return errorResponse(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata oluştu.');
    }
  });
}

function uploadErrorMessage(error: DocumentUploadError): string {
  switch (error.code) {
    case 'NOT_FOUND':
      return 'Bağlı kayıt bulunamadı.';
    case 'FORBIDDEN':
      return 'Belge yükleme yetkiniz bulunmuyor.';
    case 'CLASSIFICATION_PARENT_MISMATCH':
      return 'Belge sınıflandırması bağlı kayıtla uyumlu değil.';
    case 'IDEMPOTENCY_IN_PROGRESS':
      return 'Aynı belge yükleme işlemi sürüyor; aynı anahtarla yeniden deneyin.';
    case 'UPLOAD_RETRYABLE':
    case 'SERVICE_UNAVAILABLE':
      return 'Belge karantinaya alınamadı; aynı işlem anahtarıyla yeniden deneyin.';
    default:
      return 'Belge yükleme isteği geçersiz.';
  }
}

import { AuthHttpError, readBoundedJson } from '../auth/routes';

export async function readCommandJson(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (mediaType !== 'application/json' || (encoding && encoding !== 'identity'))
    throw new AuthHttpError(415, 'JSON_REQUIRED', 'Sıkıştırılmamış JSON gövdesi gerekli.');
  try {
    return await readBoundedJson(request, maxBytes);
  } catch (error) {
    if (error instanceof AuthHttpError && error.status === 413)
      throw new AuthHttpError(413, 'BODY_TOO_LARGE', 'İstek gövdesi çok büyük.');
    throw new AuthHttpError(400, 'INVALID_JSON', 'Geçersiz JSON gövdesi.');
  }
}

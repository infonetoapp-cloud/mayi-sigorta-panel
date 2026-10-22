import https from 'node:https';
import type { ProviderResponse } from './provider-wire';

// Independent of Undici. A single request, no proxy/redirect/fallback/retry.
// URL authorization, operation intent and the total deadline belong to the wire.
export function nodeHttpsUpload(
  url: string,
  sql: string,
  signal: AbortSignal,
  onResponse: (status: number) => void,
): Promise<ProviderResponse> {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(sql, 'utf8');
    const request = https.request(
      new URL(url),
      {
        method: 'PUT',
        signal,
        rejectUnauthorized: true,
        agent: false,
        headers: { 'content-length': String(bytes.byteLength) },
      },
      (response) => {
        onResponse(response.statusCode ?? 0);
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > 2 * 1024 * 1024) {
            const error = new Error('PROVIDER_RESPONSE_LIMIT');
            reject(error);
            response.destroy(error);
            request.destroy(error);
          } else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('aborted', () => reject(new Error('PROVIDER_BODY_ABORTED')));
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            etag: response.headers.etag,
          }),
        );
      },
    );
    request.once('error', reject);
    request.end(bytes);
  });
}

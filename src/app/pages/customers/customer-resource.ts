import { useCallback, useEffect, useRef, useState } from 'react';
import type { ZodType } from 'zod';
import type { ApiResponse } from '../../../shared/types';
import { invalidateCsrfToken } from '../../csrf';

export class CustomerReadError extends Error {
  constructor(
    readonly status: number,
    readonly code?: 'INVALID_RESPONSE',
  ) {
    super(
      code === 'INVALID_RESPONSE'
        ? 'Sunucudan beklenen bilgiler alınamadı. Yeniden deneyin.'
        : status === 401
          ? 'Oturum sona erdi. Yeniden giriş yapın.'
          : status === 403
            ? 'Bu kayıtları görüntüleme yetkiniz yok.'
            : status === 404
              ? 'Kayıt kullanılamıyor veya bu kaydı görme yetkiniz yok.'
              : 'Bilgiler yüklenemedi. Bağlantınızı kontrol edip yeniden deneyin.',
    );
  }
}
export async function readCustomerResource<T>(
  url: string,
  signal?: AbortSignal,
  decoder?: ZodType<T>,
): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal });
  signal?.throwIfAborted();
  if (response.status === 401) {
    invalidateCsrfToken();
    document.dispatchEvent(new Event('mayi-session-ended'));
  }
  if (!response.ok) throw new CustomerReadError(response.status);
  let result: ApiResponse<T>;
  try {
    result = (await response.json()) as ApiResponse<T>;
  } catch {
    signal?.throwIfAborted();
    throw new CustomerReadError(502, 'INVALID_RESPONSE');
  }
  signal?.throwIfAborted();
  if (
    typeof result !== 'object' ||
    result === null ||
    result.success !== true ||
    !('data' in result)
  )
    throw new CustomerReadError(502, 'INVALID_RESPONSE');
  if (!decoder) return result.data;
  const decoded = decoder.safeParse(result.data);
  if (!decoded.success) throw new CustomerReadError(502, 'INVALID_RESPONSE');
  return decoded.data;
}
/** URL-tagged state hides old data synchronously on navigation, before effects.
 * Abort + live guards also cover fetch implementations that don't honor abort. */
export function useCustomerResource<T>(url: string | null, decoder?: ZodType<T>) {
  const activeRead = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{
    url: string;
    data?: T;
    error?: CustomerReadError;
  }>();
  const read = useCallback(async () => {
    if (url === null) return;
    activeRead.current?.abort();
    const controller = new AbortController();
    activeRead.current = controller;
    try {
      const data = await readCustomerResource<T>(url, controller.signal, decoder);
      controller.signal.throwIfAborted();
      setResult({ url, data });
    } catch (caught) {
      controller.signal.throwIfAborted();
      const error = caught instanceof CustomerReadError ? caught : new CustomerReadError(500);
      setResult({ url, error });
      throw error;
    }
  }, [url, decoder]);
  useEffect(() => {
    void read().catch(() => {});
    return () => activeRead.current?.abort();
  }, [read]);
  function refresh() {
    setResult(undefined);
    return read();
  }
  const current = result?.url === url ? result : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: url !== null && !current,
    reload: () => void refresh().catch(() => {}),
    refresh,
  };
}

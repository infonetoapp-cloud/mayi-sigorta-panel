import { useEffect, useRef, useState } from 'react';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
interface Attempt {
  url: string;
  method: 'POST' | 'PUT';
  body: string;
  key: string;
}
/** One immutable attempt until its result is known; confirmed writes retry GET only. */
export function useVehicleWrite(onRead: (signal: AbortSignal) => Promise<void>) {
  const [pending, setPending] = useState<Attempt | null>(null),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [saved, setSaved] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const lock = useRef(false),
    life = useRef(0),
    reader = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      life.current++;
      reader.current?.abort();
    },
    [],
  );
  async function refresh(confirmed = saved) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const epoch = life.current;
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    try {
      await onRead(controller.signal);
      if (epoch !== life.current) return;
      setSaved(false);
      setBlocked(false);
      setError('');
      setMessage(
        confirmed
          ? 'Araç bilgisi kaydedildi ve güncel kayıt doğrulandı.'
          : 'Güncel bilgiler yüklendi.',
      );
    } catch {
      if (epoch === life.current)
        setError('Güncel bilgiler alınamadı. Yalnız kayıtlı bilgileri yeniden yükleyin.');
    } finally {
      if (epoch === life.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  async function send(attempt: Attempt) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setPending(attempt);
    setError('');
    setMessage('');
    const epoch = life.current;
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    try {
      const token = await getCsrfToken(controller.signal);
      if (epoch !== life.current) return;
      const response = await fetch(attempt.url, {
        method: attempt.method,
        body: attempt.body,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token,
          'Idempotency-Key': attempt.key,
        },
      });
      if (epoch !== life.current) return;
      if (response.status === 401) {
        invalidateCsrfToken();
        document.dispatchEvent(new Event('mayi-session-ended'));
      }
      const result = (await response.json()) as {
        success: boolean;
        data?: Record<string, unknown>;
        error?: { code: string };
      };
      if (epoch !== life.current) return;
      if (!response.ok || !result.success) {
        if (response.status >= 500) {
          setError('Sonuç doğrulanamadı. Aynı işlemi yeniden deneyin.');
          return;
        }
        setPending(null);
        setBlocked(true);
        setError(
          response.status === 409
            ? 'Kayıt değişti veya bu plaka zaten kayıtlı. Güncel bilgileri yükleyin.'
            : 'Kayıt için yetkinizi ve girdiğiniz bilgileri kontrol edin.',
        );
        return;
      }
      const version = Number(
        (JSON.parse(attempt.body) as { expectedVehicleVersion?: number; expectedVersion: number })
          .expectedVersion,
      );
      const expectedCustomer = attempt.url.match(/\/customers\/([^/]+)\/vehicles/);
      if (
        !result.data ||
        !Number.isSafeInteger(result.data.version) ||
        (expectedCustomer
          ? result.data.customerId !== decodeURIComponent(expectedCustomer[1]!)
          : result.data.policyId !== decodeURIComponent(attempt.url.split('/').at(-2)!)) ||
        (!expectedCustomer && Number(result.data.version) !== version + 1)
      )
        throw new Error('UNVERIFIED_WRITE');
      setPending(null);
      setSaved(true);
      lock.current = false;
      await refresh(true);
    } catch {
      if (epoch === life.current)
        setError('Sonuç doğrulanamadı. Aynı işlem anahtarıyla yeniden deneyin.');
    } finally {
      if (epoch === life.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  return {
    busy,
    pending,
    saved,
    blocked,
    error,
    message,
    locked: busy || !!pending || saved || blocked,
    unresolved: busy || !!pending || saved,
    send: (url: string, method: 'POST' | 'PUT', body: unknown) =>
      void send({ url, method, body: JSON.stringify(body), key: crypto.randomUUID() }),
    retry: () => pending && void send(pending),
    refresh: () => void refresh(),
  };
}

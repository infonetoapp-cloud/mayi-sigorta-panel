import { useEffect, useRef, useState } from 'react';
import type { ApiResponse } from '../../../shared/types';
import type { ClaimCommand, ClaimDetail, ClaimResult } from '../../../shared/claims';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { parseAppError } from '../../App';
import { CustomerReadError, readCustomerResource } from '../customers/customer-resource';
import { claimFieldsSchema } from '../../../shared/claims';
import { claimDetailFor, type ClaimScope } from './claim-read-schemas';
interface Attempt {
  body: string;
  key: string;
  command: ClaimCommand;
  scope: ClaimScope;
}
function result(value: unknown, command: ClaimCommand): value is ClaimResult {
  if (!value || typeof value !== 'object') return false;
  const r = value as ClaimResult;
  return (
    typeof r.claimId === 'string' &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(r.claimId) &&
    r.version === (command.kind === 'CREATE' ? 1 : command.expectedVersion + 1) &&
    (command.kind === 'CREATE' || r.claimId === command.claimId)
  );
}
export function useClaimWrite(onDone: (detail: ClaimDetail) => void, original?: ClaimScope) {
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Attempt | null>(null),
    [accepted, setAccepted] = useState<{ attempt: Attempt; result: ClaimResult } | null>(null),
    [error, setError] = useState(''),
    [needsRefresh, setNeedsRefresh] = useState(false);
  const lock = useRef(false),
    epoch = useRef(0),
    controllers = useRef(new Set<AbortController>()),
    done = useRef(onDone);
  done.current = onDone;
  useEffect(
    () => () => {
      epoch.current++;
      for (const c of controllers.current) c.abort();
    },
    [],
  );
  async function verify(saved: { attempt: Attempt; result: ClaimResult }, signal: AbortSignal) {
    const r = saved.result,
      c = saved.attempt.command;
    const d = await readCustomerResource(
      '/api/claims/' + encodeURIComponent(r.claimId) + '?verifyVersion=' + r.version,
      signal,
      claimDetailFor(r.claimId, saved.attempt.scope),
    );
    if (signal.aborted) return;
    if (
      d.claim.version < r.version ||
      d.verifiedHistory?.version !== r.version ||
      JSON.stringify(claimFieldsSchema.parse(d.verifiedHistory.fields)) !==
        JSON.stringify(claimFieldsSchema.parse(c.fields))
    )
      throw Error('READBACK');
    setAccepted(null);
    setPending(null);
    setError('');
    done.current(d);
  }
  async function job(work: (signal: AbortSignal) => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const e = epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    try {
      await work(c.signal);
    } catch (cause) {
      if (e === epoch.current && !c.signal.aborted)
        setError(
          cause instanceof CustomerReadError
            ? 'İşlem kaydedildi. Hasar detayı veya geçmişi doğrulanamadı. Yalnız kaydı ve geçmişi yeniden kontrol edin.'
            : 'Kaydın sonucu henüz doğrulanamadı. Taslağınız korunuyor; aşağıdaki güvenli yeniden deneme seçeneğini kullanın.',
        );
    } finally {
      controllers.current.delete(c);
      if (e === epoch.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  async function send(a: Attempt) {
    if (accepted || needsRefresh) return;
    setPending(a);
    setError('');
    await job(async (signal) => {
      const token = await getCsrfToken(signal);
      if (signal.aborted) return;
      const response = await fetch('/api/claims/commands', {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token,
          'Idempotency-Key': a.key,
        },
        body: a.body,
      });
      if (signal.aborted) return;
      const body = (await response.json().catch(() => null)) as ApiResponse<unknown> | null;
      if (signal.aborted) return;
      if (!response.ok) {
        if (response.status >= 500 || [408, 429].includes(response.status))
          throw Error('UNCERTAIN');
        setPending(null);
        setNeedsRefresh(true);
        if (response.status === 401) parseAppError(401);
        if (response.status === 403) invalidateCsrfToken();
        setError(
          response.status === 409
            ? 'Kayıt değişti veya şirket dosya numarası zaten kullanılıyor. Taslağınız korundu; güncel bilgileri karşılaştırın.'
            : 'Hasar bilgileri veya işlem yetkisi doğrulanamadı. Güncel bilgileri kontrol edin.',
        );
        return;
      }
      if (!body?.success || !result(body.data, a.command)) throw Error('UNCERTAIN');
      const saved = { attempt: a, result: body.data };
      setPending(null);
      setAccepted(saved);
      await verify(saved, signal);
    });
  }
  return {
    busy,
    error,
    needsRefresh,
    unresolved: busy || !!pending || !!accepted,
    locked: busy || !!pending || !!accepted || needsRefresh,
    pending: !!pending,
    accepted: !!accepted,
    submit(command: ClaimCommand) {
      if (lock.current || pending || accepted || needsRefresh) return;
      void send({
        body: JSON.stringify(command),
        key: crypto.randomUUID(),
        command: structuredClone(command),
        scope:
          command.kind === 'CREATE'
            ? { policyId: command.policyId, customerId: command.customerId }
            : { policyId: original?.policyId, customerId: original?.customerId },
      });
    },
    retry() {
      if (pending && !lock.current) void send(pending);
    },
    retryRead() {
      if (accepted && !lock.current) void job((signal) => verify(accepted, signal));
    },
    acceptFresh() {
      if (!pending && !accepted && !busy) {
        setNeedsRefresh(false);
        setError('');
      }
    },
  };
}

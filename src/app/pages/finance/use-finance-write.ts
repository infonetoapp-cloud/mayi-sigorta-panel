import { useEffect, useRef, useState } from 'react';
import type { ApiResponse } from '../../../shared/types';
import type { FinanceCommand, FinanceDetail, FinanceResult } from '../../../shared/finance';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { parseAppError } from '../../App';
import { CustomerReadError, readCustomerResource } from '../customers/customer-resource';
import { financeDetailFor } from './finance-read-schemas';
import { premiumMinor } from '../policies/policy-form-model';
interface Attempt {
  body: string;
  key: string;
  command: FinanceCommand;
}
function result(value: unknown, command: FinanceCommand): value is FinanceResult {
  if (!value || typeof value !== 'object') return false;
  const r = value as FinanceResult;
  return (
    typeof r.receivableId === 'string' &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(r.receivableId) &&
    r.version === (command.kind === 'CREATE' ? 1 : command.expectedVersion + 1) &&
    (command.kind === 'CREATE' || r.receivableId === command.receivableId) &&
    (['COLLECT', 'REVERSE'].includes(command.kind)
      ? typeof r.entryId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(r.entryId)
      : r.entryId === null)
  );
}
export function useFinanceWrite(onDone: (detail: FinanceDetail) => void) {
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Attempt | null>(null),
    [accepted, setAccepted] = useState<{ attempt: Attempt; result: FinanceResult } | null>(null),
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
  async function verify(saved: { attempt: Attempt; result: FinanceResult }, signal: AbortSignal) {
    const r = saved.result,
      c = saved.attempt.command,
      query = r.entryId
        ? 'verifyEntry=' + encodeURIComponent(r.entryId)
        : 'verifyVersion=' + r.version;
    const d = await readCustomerResource(
      '/api/finance/receivables/' + encodeURIComponent(r.receivableId) + '?' + query,
      signal,
      financeDetailFor(r.receivableId),
    );
    if (signal.aborted) return;
    if (d.receivable.version < r.version) throw Error('READBACK');
    if (c.kind === 'COLLECT' || c.kind === 'REVERSE') {
      const e = d.verifiedEntry;
      if (
        !e ||
        e.id !== r.entryId ||
        (c.kind === 'COLLECT'
          ? e.kind !== 'PAYMENT' ||
            BigInt(e.amountMinor) !== premiumMinor(c.amount) ||
            e.method !== c.method ||
            e.receivedDate !== c.receivedDate
          : e.kind !== 'REVERSAL' || e.reversesId !== c.entryId || e.reasonCode !== c.reasonCode)
      )
        throw Error('READBACK');
    } else {
      const v = d.verifiedRevision;
      if (
        !v ||
        v.version !== r.version ||
        (c.kind === 'VOID'
          ? v.status !== 'VOIDED'
          : v.status !== 'ACTIVE' ||
            BigInt(v.amountMinor) !== premiumMinor(c.amount) ||
            v.dueDate !== c.dueDate)
      )
        throw Error('READBACK');
      if (c.kind === 'CREATE' && d.receivable.policyId !== c.policyId) throw Error('READBACK');
    }
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
            ? 'İşlem kaydedildi. Güncel hareketler veya bakiye doğrulanamadı. Yalnız kaydı ve bakiyeyi yeniden kontrol edin.'
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
      const response = await fetch('/api/finance/commands', {
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
            ? 'Kayıt değişti veya tutar kalan alacakla uyuşmuyor. Taslağınız korundu; güncel bilgileri karşılaştırın.'
            : 'Tutar, tarih veya işlem yetkisi doğrulanamadı. Güncel bilgileri kontrol edin.',
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
    submit(command: FinanceCommand) {
      if (lock.current || pending || accepted || needsRefresh) return;
      void send({
        body: JSON.stringify(command),
        key: crypto.randomUUID(),
        command: structuredClone(command),
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

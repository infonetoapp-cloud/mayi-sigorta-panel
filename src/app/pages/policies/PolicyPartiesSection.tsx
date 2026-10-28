import { useEffect, useRef, useState } from 'react';
import type {
  ApiResponse,
  CustomerDetailDto,
  PolicyDetailDto,
  PolicyPartyDto,
} from '../../../shared/types';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { parseAppError } from '../../App';
import { readCustomerResource, useCustomerResource } from '../customers/customer-resource';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { PolicyReadNotice } from './policy-display';
import { PartyCustomerPicker, type PartyCustomer } from './PartyCustomerPicker';
type Mode = { kind: 'create' } | { kind: 'deactivate'; target: PolicyPartyDto };
interface Snapshot {
  policy: PolicyDetailDto;
  parties: PolicyPartyDto[];
}
interface Attempt {
  url: string;
  method: 'POST';
  body: string;
  key: string;
  kind: 'create' | 'deactivate';
}
export function PolicyPartiesSection({
  policy,
  onUpdated,
}: {
  policy: PolicyDetailDto;
  onUpdated: (policy: PolicyDetailDto) => void;
}) {
  const base = `/api/policies/${encodeURIComponent(policy.id)}`;
  const [draftVersion, setDraftVersion] = useState(policy.version);
  const initial = useCustomerResource<PolicyPartyDto[]>(base + '/parties');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [comparison, setComparison] = useState<Snapshot | null>(null);
  const [mode, setMode] = useState<Mode | null>(null),
    [selected, setSelected] = useState<PartyCustomer | null>(null),
    [role, setRole] = useState('');
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [needsComparison, setNeedsComparison] = useState(false),
    [needsRead, setNeedsRead] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  const epoch = useRef(0),
    saving = useRef(false),
    readers = useRef(new Set<AbortController>()),
    completed = useRef<Attempt['kind'] | null>(null);
  useEffect(
    () => () => {
      epoch.current++;
      for (const r of readers.current) r.abort();
      readers.current.clear();
    },
    [],
  );
  const current = snapshot?.policy ?? policy,
    parties = snapshot?.parties ?? initial.data;
  const archived = policy.archivedAt != null || current.archivedAt != null;
  const hidden = blocked || !!initial.error;
  const locked =
    busy ||
    blocked ||
    !!pending ||
    needsRead ||
    needsComparison ||
    archived ||
    !parties ||
    !!initial.error;
  const target =
    mode?.kind === 'deactivate' ? parties?.find((p) => p.id === mode.target.id) : undefined;
  const comparisonTarget =
    mode?.kind === 'deactivate'
      ? comparison?.parties.find((p) => p.id === mode.target.id)
      : undefined;
  async function read<T>(operation: (signal: AbortSignal) => Promise<T>) {
    const c = new AbortController();
    readers.current.add(c);
    try {
      return await operation(c.signal);
    } finally {
      readers.current.delete(c);
    }
  }
  function get<T>(url: string) {
    return read((signal) => readCustomerResource<T>(url, signal));
  }
  function block(cause: unknown) {
    const status =
      cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : 0;
    if ([401, 403, 404].includes(status)) setBlocked(true);
  }
  async function refresh() {
    if (busy) return;
    await load();
  }
  async function load() {
    const view = epoch.current;
    setBusy(true);
    try {
      const [fresh, rows] = await Promise.all([
        get<PolicyDetailDto>(base),
        get<PolicyPartyDto[]>(base + '/parties'),
      ]);
      if (view !== epoch.current) return;
      if (
        fresh.id !== policy.id ||
        !Array.isArray(rows) ||
        rows.some((p) => p.policyId !== policy.id)
      )
        throw new Error('INVALID_READBACK');
      setSnapshot({ policy: fresh, parties: rows });
      onUpdated(fresh);
      if (completed.current) {
        setSuccess(
          completed.current === 'create'
            ? 'Poliçe tarafı eklendi.'
            : 'Poliçe tarafı pasifleştirildi.',
        );
        completed.current = null;
        setMode(null);
        setSelected(null);
        setRole('');
        setNeedsRead(false);
        setPending(null);
        setComparison(null);
        setError('');
      } else {
        if (fresh.archivedAt) {
          setNeedsComparison(true);
          setError('Arşivlenmiş poliçe salt okunurdur.');
          return;
        }
        if (mode?.kind === 'create') {
          if (!selected) throw new Error('CUSTOMER_SELECTION_REQUIRED');
          const c = await get<CustomerDetailDto>(
            `/api/customers/${encodeURIComponent(selected.id)}`,
          );
          if (view !== epoch.current) return;
          if (c.id !== selected.id || c.archivedAt) {
            setSelected(null);
            throw new Error('CUSTOMER_UNAVAILABLE');
          }
          setSelected({ id: c.id, displayName: c.displayName });
        }
        setComparison({ policy: fresh, parties: rows });
        setNeedsComparison(false);
        setError('');
      }
    } catch (cause) {
      if (view !== epoch.current) return;
      block(cause);
      setError(
        completed.current
          ? 'İşlem kaydedildi; yetkili poliçe ve taraf listesi okunamadı. Yalnız GET yeniden denenecek.'
          : 'Güncel kayıtlar veya seçili müşteri doğrulanamadı. Taslağınız korundu; yeniden karşılaştırın.',
      );
    } finally {
      if (view === epoch.current) setBusy(false);
    }
  }
  async function send(attempt: Attempt) {
    if (saving.current || blocked || needsRead) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setSuccess('');
    const view = epoch.current;
    try {
      const csrf = await read((signal) => getCsrfToken(signal));
      if (view !== epoch.current) return;
      const result = await fetch(attempt.url, {
        method: attempt.method,
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': attempt.key,
        },
        body: attempt.body,
      });
      if (view !== epoch.current) return;
      if (result.status === 401) {
        parseAppError(401);
        setBlocked(true);
        setError('Oturum sona erdi. Yeniden giriş yapın.');
        return;
      }
      const envelope = (await result
        .json()
        .catch(() => null)) as ApiResponse<PolicyPartyDto> | null;
      if (view !== epoch.current) return;
      if (!result.ok) {
        if (result.status === 403) invalidateCsrfToken();
        const info = parseAppError(
          result.status,
          envelope && !envelope.success ? envelope.error : null,
        );
        if (info.isRetryable || result.status === 429) throw new Error('UNCERTAIN');
        setPending(null);
        if (result.status === 409) {
          setNeedsComparison(true);
          setComparison(null);
          setError(
            'Poliçe veya taraf kaydı değişti. Taslağınız korundu; güncel kayıtları karşılaştırıp açıkça yeniden onaylayın.',
          );
        } else {
          setError(info.message);
          if ([403, 404].includes(result.status)) setBlocked(true);
        }
        return;
      }
      if (!envelope?.success || envelope.data?.policyId !== policy.id) throw new Error('UNCERTAIN');
      setPending(null);
      completed.current = attempt.kind;
      setNeedsRead(true);
      await load();
    } catch {
      if (view === epoch.current) {
        setPending(attempt);
        setError(
          'Sonuç belirsiz. Form kilitlendi; yalnız aynı işlem ve anahtarla yeniden deneyin. Sayfayı yenilemeyin.',
        );
      }
    } finally {
      saving.current = false;
      if (view === epoch.current) setBusy(false);
    }
  }
  function open(next: Mode) {
    if (locked) return;
    setDraftVersion(current.version);
    setMode(next);
    setComparison(null);
    setError('');
    setSuccess('');
    setRole('');
    setSelected(null);
  }
  function submit() {
    if (!mode || locked || saving.current) return;
    let payload: Record<string, unknown>, url: string;
    if (mode.kind === 'create') {
      if (!selected || !['INSURED', 'BENEFICIARY'].includes(role)) {
        setError('Müşteriyi doğrulayarak ve rolü açıkça seçerek devam edin.');
        return;
      }
      payload = {
        customerId: selected.id,
        role,
        expectedVersion: comparison?.policy.version ?? draftVersion,
      };
      url = base + '/parties';
    } else {
      const p = comparison ? comparisonTarget : mode.target;
      if (!p || p.status !== 'ACTIVE') {
        setError('Seçilen taraf artık aktif değil; yeni bir işlem seçin.');
        return;
      }
      payload = { expectedVersion: p.version };
      url = base + '/parties/' + encodeURIComponent(p.id) + '/deactivate';
    }
    void send({
      url,
      method: 'POST',
      body: JSON.stringify(payload),
      key: crypto.randomUUID(),
      kind: mode.kind,
    });
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sigortalılar ve lehtarlar</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="customer-legacy-hint">
          Yalnız bu poliçedeki ad, rol ve durum özeti gösterilir. Bağlantı, kişinin müşteri
          profiline veya diğer poliçelerine erişim vermez. Pasifleştirme müşteri arşivleme veya
          poliçe iptali değildir.
        </p>
        <PolicyReadNotice
          loading={!snapshot && initial.loading}
          error={initial.error}
          reload={initial.reload}
        />
        {archived && <p>Arşivlenmiş poliçenin taraf geçmişi salt okunurdur.</p>}
        {error && <p role="alert">{error}</p>}
        {success && <p role="status">{success}</p>}
        {busy && <p role="status">İşlem sürüyor…</p>}
        {pending && (
          <Button disabled={busy || blocked} variant="outline" onClick={() => void send(pending)}>
            Aynı işlemi yeniden dene
          </Button>
        )}
        {needsRead && (
          <Button disabled={busy} variant="outline" onClick={() => void refresh()}>
            Kaydedilen tarafları yeniden oku
          </Button>
        )}
        {needsComparison && !needsRead && !blocked && (
          <Button disabled={busy} variant="outline" onClick={() => void refresh()}>
            Güncel tarafları karşılaştır
          </Button>
        )}
        {!hidden && (
          <>
            {!archived && !mode && (
              <Button disabled={locked} onClick={() => open({ kind: 'create' })}>
                Taraf ekle
              </Button>
            )}
            {mode && (
              <form
                aria-label="Poliçe tarafı işlemi"
                className="policy-contract-form customer-edit-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                <h3 tabIndex={-1}>
                  {mode.kind === 'create' ? 'Yeni sigortalı / lehtar' : 'Taraf pasifleştirme onayı'}
                </h3>
                {mode.kind === 'create' ? (
                  <>
                    <PartyCustomerPicker disabled={locked} onSelected={setSelected} />
                    <fieldset disabled={locked}>
                      <label htmlFor="party-role">Taraf rolü</label>
                      <select
                        id="party-role"
                        value={role}
                        onChange={(event) => setRole(event.target.value)}
                      >
                        <option value="">Rol seçin</option>
                        <option value="INSURED">Sigortalı</option>
                        <option value="BENEFICIARY">Lehtar</option>
                      </select>
                    </fieldset>
                  </>
                ) : (
                  <p>
                    {mode.target.customerDisplayName} ·{' '}
                    {mode.target.role === 'INSURED' ? 'Sigortalı' : 'Lehtar'} pasifleştirilecek.
                    Geçmiş silinmez; müşteri veya poliçe durumu değiştirilmez.
                  </p>
                )}
                {comparison && (
                  <aside className="company-contact-comparison" role="status">
                    <strong>Karşılaştırılan poliçe sürümü: {comparison.policy.version}</strong>
                    {mode.kind === 'deactivate' && (
                      <p>
                        Karşılaştırılan taraf:{' '}
                        {comparisonTarget?.customerDisplayName ?? 'Kullanılamıyor'} ·{' '}
                        {comparisonTarget?.status === 'ACTIVE' ? 'Aktif' : 'Pasif / kullanılamıyor'}{' '}
                        · sürüm {comparisonTarget?.version ?? '—'}
                      </p>
                    )}
                    {mode.kind === 'create' && (
                      <p>
                        Seçili müşteri: {selected?.displayName} ·{' '}
                        {role === 'INSURED'
                          ? 'Sigortalı'
                          : role === 'BENEFICIARY'
                            ? 'Lehtar'
                            : 'Rol seçilmedi'}
                      </p>
                    )}
                    <p>Güncel listeyi ve taslağınızı inceleyerek yeniden onaylayın.</p>
                  </aside>
                )}
                <div className="customer-form-actions">
                  <Button
                    type="submit"
                    disabled={
                      locked ||
                      (mode.kind === 'deactivate' && (!target || target.status !== 'ACTIVE'))
                    }
                  >
                    {comparison
                      ? 'Karşılaştırdım, işlemi onayla'
                      : mode.kind === 'create'
                        ? 'Tarafı kaydet'
                        : 'Pasifleştirmeyi onayla'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || !!pending || needsRead}
                    onClick={() => {
                      setMode(null);
                      setSelected(null);
                      setRole('');
                      setNeedsComparison(false);
                      setComparison(null);
                      setError('');
                    }}
                  >
                    Vazgeç
                  </Button>
                </div>
              </form>
            )}
            <ul className="customer-related-list">
              {parties?.map((p) => (
                <li key={p.id}>
                  <section
                    aria-label={`${p.customerDisplayName} ${p.role === 'INSURED' ? 'Sigortalı' : 'Lehtar'}`}
                  >
                    <strong>{p.customerDisplayName}</strong>
                    <p>
                      {p.role === 'INSURED' ? 'Sigortalı' : 'Lehtar'} ·{' '}
                      {p.status === 'ACTIVE' ? 'Aktif' : 'Pasif'}
                    </p>
                    {p.status === 'ACTIVE' && !archived && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={locked || !!mode}
                        onClick={() => open({ kind: 'deactivate', target: p })}
                      >
                        Tarafı pasifleştir
                      </Button>
                    )}
                  </section>
                </li>
              ))}
            </ul>
            {parties && !parties.length && <p>Bu bölümde kayıt bulunmuyor.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

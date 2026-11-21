import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { CustomerDetailDto, ApiResponse } from '../../../shared/types';
import type { InsurerNumberOptions } from '../../../shared/insurer-customer-number';
import { Button } from '../../components/ui/button';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { readCustomerResource, useCustomerResource } from './customer-resource';
import { insurerNumberOptionsSchema, insurerNumbersSchema } from './customer-read-schemas';
import { CustomerNumberGuard } from './CustomerNumberGuard';

interface Attempt {
  url: string;
  body: string;
  key: string;
}
export function CustomerInsurerNumbers({
  customer,
  onCustomerReload,
  visible,
}: {
  customer: CustomerDetailDto;
  onCustomerReload: () => Promise<void>;
  visible: boolean;
}) {
  const root = `/api/customers/${encodeURIComponent(customer.id)}`,
    id = useId();
  const records = useCustomerResource(root + '/insurer-numbers', insurerNumbersSchema);
  const rows = records.data;
  const [editing, setEditing] = useState(false),
    [insurer, setInsurer] = useState(''),
    [number, setNumber] = useState('');
  const [options, setOptions] = useState<InsurerNumberOptions>({ items: [], nextCursor: null });
  const [optionsError, setOptionsError] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [pending, setPending] = useState<Attempt | null>(null),
    [saved, setSaved] = useState(false),
    [conflict, setConflict] = useState(false);
  const lock = useRef(false),
    life = useRef(0),
    reader = useRef<AbortController | null>(null),
    mutationReader = useRef<AbortController | null>(null),
    optionBusy = useRef(false);
  useEffect(
    () => () => {
      life.current++;
      reader.current?.abort();
      mutationReader.current?.abort();
    },
    [],
  );
  const dirty = editing && (!!insurer || !!number);
  async function loadOptions(after = '') {
    if (optionBusy.current) return;
    optionBusy.current = true;
    const epoch = life.current;
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    try {
      const data = await readCustomerResource<InsurerNumberOptions>(
        root + '/insurer-number-options' + (after ? '?after=' + encodeURIComponent(after) : ''),
        controller.signal,
        insurerNumberOptionsSchema,
      );
      if (epoch === life.current) {
        setOptionsError('');
        setOptions((old) => ({
          items: after
            ? [...old.items, ...data.items.filter((i) => !old.items.some((o) => o.id === i.id))]
            : data.items,
          nextCursor: data.nextCursor,
        }));
      }
    } catch (caught) {
      if (
        epoch === life.current &&
        !(caught instanceof DOMException && caught.name === 'AbortError')
      )
        setOptionsError('Şirket listesi alınamadı. Şirket listesini yeniden yükleyin.');
    } finally {
      if (epoch === life.current) optionBusy.current = false;
    }
  }
  async function refresh(written = false) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const epoch = life.current;
    try {
      await onCustomerReload();
      if (epoch !== life.current) return;
      await records.refresh();
      if (epoch !== life.current) return;
      setConflict(false);
      setSaved(false);
      setEditing(false);
      setInsurer('');
      setNumber('');
      setError('');
      setMessage(
        written || saved
          ? 'Şirket müşteri numarası kaydedildi ve bilgiler yenilendi.'
          : 'Güncel müşteri bilgileri yüklendi. Numara ekleme veya düzeltmeyi yeniden açabilirsiniz.',
      );
    } catch {
      if (epoch === life.current)
        setError('Güncel müşteri kartı veya şirket numaraları yüklenemedi. Yeniden deneyin.');
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
    setError('');
    setPending(attempt);
    const epoch = life.current;
    try {
      mutationReader.current?.abort();
      const controller = new AbortController();
      mutationReader.current = controller;
      const token = await getCsrfToken(controller.signal);
      if (epoch !== life.current) return;
      const response = await fetch(attempt.url, {
        method: 'PUT',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token,
          'Idempotency-Key': attempt.key,
        },
        body: attempt.body,
      });
      if (epoch !== life.current) return;
      if (response.status === 401) {
        invalidateCsrfToken();
        document.dispatchEvent(new Event('mayi-session-ended'));
      }
      const result = (await response.json()) as ApiResponse<{
        customerId: string;
        externalKey: string;
        sourceNamespace: string;
      }>;
      if (epoch !== life.current) return;
      if (!response.ok || !result.success) {
        const code = !result.success ? result.error?.code : '';
        if (response.status >= 500) {
          setError('Sonuç doğrulanamadı. Aynı işlemi yeniden deneyin.');
          return;
        }
        setPending(null);
        if (response.status === 409) {
          setConflict(true);
          setError(
            code === 'DUPLICATE_EXTERNAL_REFERENCE'
              ? 'Bu şirket müşteri numarası zaten kayıtlı. Bilgileri kontrol edin.'
              : 'Müşteri bilgileri değişti. Güncel bilgileri yükleyip yeniden deneyin.',
          );
        } else
          setError(
            [401, 403, 404].includes(response.status)
              ? 'Bu kayıt için oturum veya düzenleme yetkisi gerekli.'
              : 'Şirket ve müşteri numarasını kontrol edin.',
          );
        return;
      }
      const expected = JSON.parse(attempt.body) as { customerNumber: string };
      if (
        result.data?.customerId !== customer.id ||
        result.data.externalKey !== expected.customerNumber ||
        result.data.sourceNamespace !==
          'insurer:' + decodeURIComponent(attempt.url.split('/').pop()!)
      )
        throw new Error('UNVERIFIED_WRITE');
      setPending(null);
      setSaved(true);
      setMessage('Numara kaydedildi. Güncel bilgiler kontrol ediliyor.');
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
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      busy ||
      pending ||
      saved ||
      conflict ||
      customer.archivedAt ||
      !insurer ||
      !number.trim() ||
      !rows
    )
      return;
    void send({
      url: root + '/insurer-numbers/' + encodeURIComponent(insurer),
      key: crypto.randomUUID(),
      body: JSON.stringify({ expectedVersion: customer.version, customerNumber: number.trim() }),
    });
  }
  return (
    <>
      <CustomerNumberGuard dirty={dirty} unresolved={!!pending || saved || busy} />
      <section
        hidden={!visible}
        className="customer-insurer-numbers"
        aria-label="Şirket müşteri numaraları"
      >
        <div className="customer-number-heading">
          <h2>Şirket müşteri numaraları</h2>
          {!editing && !customer.archivedAt && (
            <Button
              variant="outline"
              onClick={() => {
                setEditing(true);
                setMessage('');
                void loadOptions();
              }}
            >
              Müşteri numarası ekle / düzelt
            </Button>
          )}
        </div>
        <p>
          Sigorta şirketinin verdiği numarayı elle kaydedin. Şirket sistemlerine bağlantı kurulmaz.
        </p>
        {records.loading && <p role="status">Müşteri numaraları yükleniyor…</p>}
        {records.error && !saved && !conflict && (
          <div role="alert">
            <p>{records.error.message}</p>
            <Button variant="outline" onClick={records.reload}>
              Numaraları yeniden yükle
            </Button>
          </div>
        )}
        {rows && (
          <>
            {!rows.length ? (
              <p>Henüz şirket müşteri numarası kaydedilmedi.</p>
            ) : (
              <dl className="customer-number-list">
                {rows.map((r, index) => (
                  <div key={r.insurerId + ':' + index}>
                    <dt>{r.insurerName}</dt>
                    <dd>{r.customerNumber}</dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        )}
        {editing && (
          <form
            aria-labelledby={id + '-title'}
            action={root + '/insurer-numbers/' + encodeURIComponent(insurer)}
            method="post"
            onSubmit={submit}
          >
            <h3 id={id + '-title'}>Müşteri numarası ekle veya düzelt</h3>
            <fieldset disabled={busy || !!pending || saved || conflict || !!customer.archivedAt}>
              <legend>Şirket ve numara</legend>
              <label htmlFor={id + '-insurer'}>Sigorta şirketi (zorunlu)</label>
              <select
                id={id + '-insurer'}
                name="insurerId"
                required
                value={insurer}
                onChange={(e) => {
                  setInsurer(e.target.value);
                  setNumber(
                    rows?.find((r) => r.insurerId === e.target.value)?.customerNumber ?? '',
                  );
                  setError('');
                }}
              >
                <option value="">Şirket seçin</option>
                {options.items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
              {optionsError && <p role="alert">{optionsError}</p>}
              <Button variant="ghost" onClick={() => void loadOptions(options.nextCursor ?? '')}>
                {options.nextCursor && !optionsError
                  ? 'Diğer şirketleri yükle'
                  : 'Şirket listesini yeniden yükle'}
              </Button>
              <label htmlFor={id + '-number'}>Şirket müşteri no (zorunlu)</label>
              <input
                id={id + '-number'}
                name="customerNumber"
                type="text"
                required
                maxLength={100}
                value={number}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby={id + '-help'}
                onChange={(e) => {
                  setNumber(e.target.value);
                  setError('');
                }}
              />
              <p id={id + '-help'}>
                Baştaki sıfırlar korunur. Seçili şirkette kayıt varsa yeni numara eskisinin yerine
                kaydedilir.
              </p>
              <div className="customer-form-actions">
                <Button type="submit" disabled={!rows}>
                  Numarayı kaydet
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setInsurer('');
                    setNumber('');
                    setError('');
                  }}
                >
                  Vazgeç
                </Button>
              </div>
            </fieldset>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
        {pending && (
          <Button variant="outline" disabled={busy} onClick={() => void send(pending)}>
            Aynı kaydı yeniden dene
          </Button>
        )}
        {(saved || conflict) && (
          <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
            {saved ? 'Kayıtlı bilgileri doğrula' : 'Güncel bilgileri yükle'}
          </Button>
        )}
        {busy && <p role="status">Bilgiler işleniyor…</p>}
      </section>
    </>
  );
}

import { useEffect, useId, useRef, useState } from 'react';
import type {
  CustomerReferenceOption,
  CustomerReferenceOptions,
} from '../../../shared/customer-profile';
import { readCustomerResource } from './customer-resource';
import { Button } from '../../components/ui/button';

/** Native selection preserves keyboard/mobile support; duplicate names retain distinct IDs. */
export function CustomerReferenceField({
  membershipId,
  name,
  onChange,
  filtering = false,
}: {
  membershipId: string;
  name: string;
  onChange: (membershipId: string, name: string) => void;
  filtering?: boolean;
}) {
  const id = useId();
  const [manual, setManual] = useState(!membershipId && !!name);
  const [items, setItems] = useState<CustomerReferenceOption[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function load(next?: string) {
    if (request.current) return;
    request.current = true;
    setBusy(true);
    setError('');
    const active = new AbortController();
    controller.current = active;
    try {
      const data = await readCustomerResource<CustomerReferenceOptions>(
        '/api/customers/reference-options' + (next ? '?cursor=' + encodeURIComponent(next) : ''),
        active.signal,
      );
      if (active.signal.aborted) return;
      if (!Array.isArray(data.items)) throw new Error('INVALID_OPTIONS');
      setItems((old) => [
        ...(next ? old : []),
        ...data.items.filter(
          (item) => !next || !old.some((prior) => prior.membershipId === item.membershipId),
        ),
      ]);
      setCursor(data.nextCursor);
      setLoaded(true);
    } catch {
      if (!active.signal.aborted)
        setError('Çalışan listesi alınamadı. Yeniden deneyebilir veya elle isim girebilirsiniz.');
    } finally {
      request.current = false;
      if (!active.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="customer-reference-field">
      <label htmlFor={id}>Referans kişi</label>
      <select
        id={id}
        name="referenceMembershipId"
        value={manual ? 'manual' : membershipId}
        onFocus={() => {
          if (!loaded) void load();
        }}
        onChange={(event) => {
          const value = event.target.value;
          setManual(value === 'manual');
          const person = items.find((item) => item.membershipId === value);
          onChange(person?.membershipId ?? '', person?.displayName ?? '');
        }}
        aria-describedby={id + '-help'}
      >
        <option value="">{filtering ? 'Tüm referanslar' : 'Belirtilmedi'}</option>
        {membershipId && !items.some((item) => item.membershipId === membershipId) && (
          <option value={membershipId}>{name} · kayıtlı referans</option>
        )}
        {items.map((person) => (
          <option key={person.membershipId} value={person.membershipId}>
            {person.displayName}
          </option>
        ))}
        <option value="manual">{filtering ? 'İsme göre ara…' : 'Elle isim gir…'}</option>
      </select>
      {manual && (
        <>
          <label htmlFor={id + '-name'}>Referans kişinin adı soyadı</label>
          <input
            id={id + '-name'}
            name="referenceName"
            maxLength={120}
            value={name}
            onChange={(event) => onChange('', event.target.value)}
          />
        </>
      )}
      <small id={id + '-help'}>
        Çalışan seçebilir veya listede olmayan birini elle girebilirsiniz.
      </small>
      {busy && <span role="status">Çalışanlar yükleniyor…</span>}
      {error && (
        <>
          <p role="alert">{error}</p>
          <Button type="button" variant="outline" onClick={() => void load(cursor ?? undefined)}>
            Listeyi yeniden yükle
          </Button>
        </>
      )}
      {cursor && !busy && (
        <Button type="button" variant="outline" onClick={() => void load(cursor)}>
          Diğer çalışanları yükle
        </Button>
      )}
    </div>
  );
}

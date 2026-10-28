import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, Fingerprint, Search } from 'lucide-react';
import type { ApiResponse, CustomerDto } from '../../../shared/types';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent } from '../../components/ui/card';
export default function IdentitySearchPage() {
  const [type, setType] = useState<'TCKN' | 'VKN'>('TCKN');
  const [value, setValue] = useState('');
  const [results, setResults] = useState<readonly CustomerDto[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0),
    reader = useRef<AbortController | null>(null),
    lock = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
      reader.current?.abort();
    },
    [],
  );
  const clear = () => {
    generation.current++;
    reader.current?.abort();
    lock.current = false;
    setValue('');
    setResults(null);
    setError('');
    setBusy(false);
  };
  async function search(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    if (!new RegExp(`^\\d{${type === 'TCKN' ? 11 : 10}}$`).test(value.trim())) {
      setError(type === 'TCKN' ? '11 haneli TCKN girin.' : '10 haneli VKN girin.');
      return;
    }
    const current = ++generation.current,
      controller = new AbortController();
    reader.current?.abort();
    reader.current = controller;
    lock.current = true;
    setBusy(true);
    setResults(null);
    setError('');
    try {
      const csrf = await getCsrfToken(controller.signal);
      if (current !== generation.current) return;
      const response = await fetch('/api/customers/search-sensitive', {
        method: 'POST',
        cache: 'no-store',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ identityType: type, identityValue: value.trim() }),
      });
      if (current !== generation.current) return;
      if (response.status === 401) {
        invalidateCsrfToken();
        document.dispatchEvent(new Event('mayi-session-ended'));
        return;
      }
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? 'Kimlik numarasıyla arama yetkiniz yok.'
            : 'Arama tamamlanamadı. Bilgileri kontrol edip yeniden deneyin.',
        );
      const json = (await response.json()) as ApiResponse<CustomerDto[]>;
      if (current !== generation.current) return;
      if (!json.success || !Array.isArray(json.data))
        throw new Error('Arama sonucu okunamadı. Yeniden deneyin.');
      setResults(json.data);
      setValue('');
    } catch (cause) {
      if (current === generation.current && !controller.signal.aborted)
        setError(
          cause instanceof Error && cause.message.startsWith('Kimlik numarasıyla')
            ? cause.message
            : 'Arama tamamlanamadı. Bağlantınızı kontrol edip yeniden deneyin.',
        );
    } finally {
      if (current === generation.current) {
        setBusy(false);
        lock.current = false;
      }
    }
  }
  return (
    <div className="customer-modern">
      <Link className="customer-back-link" to="/customers">
        <ArrowLeft size={16} aria-hidden="true" /> Müşteri listesine dön
      </Link>
      <PageHeader
        title="Kimlik numarasıyla müşteri bul"
        description="TCKN veya VKN ile tam eşleşme. Yalnız yetkili olduğunuz müşteriler gösterilir."
      />
      <Card>
        <CardContent className="customer-state">
          <form onSubmit={search} className="customer-list-toolbar">
            <div>
              <label htmlFor="identity-search-type">Kimlik türü</label>
              <select
                id="identity-search-type"
                value={type}
                disabled={busy}
                onChange={(e) => {
                  clear();
                  setType(e.target.value as 'TCKN' | 'VKN');
                }}
              >
                <option value="TCKN">TCKN · Bireysel</option>
                <option value="VKN">VKN · Kurumsal</option>
              </select>
            </div>
            <div className="customer-search">
              <label htmlFor="identity-search-value">Kimlik numarası</label>
              <Input
                id="identity-search-value"
                data-sensitive="true"
                autoComplete="off"
                inputMode="numeric"
                value={value}
                disabled={busy}
                maxLength={type === 'TCKN' ? 11 : 10}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy}>
              <Search size={16} aria-hidden="true" />
              {busy ? 'Aranıyor…' : 'Müşteri Bul'}
            </Button>
            <Button variant="ghost" onClick={clear}>
              Temizle
            </Button>
          </form>
          {error && <p role="alert">{error}</p>}
          {results && !results.length && <p role="status">Eşleşen müşteri bulunamadı.</p>}
          {results && results.length > 0 && (
            <ul className="interaction-timeline" aria-label="Kimlik arama sonuçları">
              {results.map((customer) => (
                <li key={customer.id}>
                  <Link
                    to={`/customers/${encodeURIComponent(customer.id)}`}
                    className="customer-name"
                  >
                    <Fingerprint size={16} aria-hidden="true" /> {customer.displayName}
                  </Link>
                  <p>
                    {customer.type === 'COMPANY' ? 'Kurumsal müşteri' : 'Bireysel müşteri'}
                    {customer.identityMasked ? ` · ${customer.identityMasked}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

import { useState, type FormEvent } from 'react';

import { Link } from 'react-router';
import { ArrowRight, Plus, Search, Users } from 'lucide-react';
import type { CustomerListResponseData } from '../../../shared/types';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';
import { useCustomerResource } from './customer-resource';

export default function CustomerListPage() {
  const [search, setSearch] = useState('');
  const [type, setType] = useState('ALL');
  const [filter, setFilter] = useState({ search: '', type: 'ALL' });
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const params = new URLSearchParams({ limit: '20' });
  if (filter.search) params.set('search', filter.search);
  if (filter.type !== 'ALL') params.set('type', filter.type);
  const cursor = cursors.at(-1);
  if (cursor) params.set('cursor', cursor);
  const { data, loading, error, reload } = useCustomerResource<CustomerListResponseData>(
    `/api/customers?${params}`,
  );
  function submit(event: FormEvent) {
    event.preventDefault();
    setCursors([null]);
    setFilter({ search: search.trim(), type });
    reload();
  }
  return (
    <div className="customer-modern">
      <PageHeader
        title="Müşteriler"
        description="Müşteri ilişkilerini ve acentenizin ortak müşteri geçmişini yönetin."
        action={
          <Button asChild>
            <Link to="/customers/new">
              <Plus aria-hidden="true" />
              Yeni Müşteri
            </Link>
          </Button>
        }
      />
      <Card className="customer-list-card">
        <form className="customer-list-toolbar" onSubmit={submit}>
          <div className="customer-search">
            <label htmlFor="customer-search">Müşteri ara</label>
            <Input
              id="customer-search"
              placeholder="Ad, unvan veya iletişim bilgisi"
              maxLength={200}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="customer-type">Müşteri türü</label>
            <select
              id="customer-type"
              value={type}
              onChange={(event) => setType(event.target.value)}
            >
              <option value="ALL">Tüm müşteriler</option>
              <option value="INDIVIDUAL">Bireysel</option>
              <option value="COMPANY">Kurumsal</option>
            </select>
          </div>
          <Button type="submit" variant="outline">
            <Search aria-hidden="true" />
            Ara
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSearch('');
              setType('ALL');
              setFilter({ search: '', type: 'ALL' });
              setCursors([null]);
              reload();
            }}
          >
            Temizle
          </Button>
        </form>
        {loading && (
          <div role="status" className="customer-state">
            Müşteriler yükleniyor…
          </div>
        )}
        {error && (
          <div role="alert" className="customer-state">
            <h2>{error.status === 403 ? 'Erişim izni gerekli' : 'Müşteriler yüklenemedi'}</h2>
            <p>{error.message}</p>
            {error.status !== 403 && error.status !== 401 && (
              <Button variant="outline" onClick={reload}>
                Yeniden dene
              </Button>
            )}
          </div>
        )}
        {data && !data.items.length && (
          <div className="customer-state">
            <Users aria-hidden="true" />
            <h2>Müşteri bulunamadı</h2>
            <p>
              Arama ve tür seçimini değiştirebilir veya yetkiniz varsa yeni müşteri
              oluşturabilirsiniz.
            </p>
          </div>
        )}
        {data && !!data.items.length && (
          <>
            <table className="customer-table">
              <caption className="sr-only">
                Müşteri listesi — yalnız erişiminiz olan kayıtlar
              </caption>
              <thead>
                <tr>
                  <th>Müşteri</th>
                  <th>Tür</th>
                  <th>İletişim</th>
                  <th>Durum</th>
                  <th>
                    <span className="sr-only">Aç</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((customer) => (
                  <tr key={customer.id}>
                    <td data-label="Müşteri">
                      <Link
                        className="customer-name"
                        to={`/customers/${encodeURIComponent(customer.id)}`}
                      >
                        {customer.displayName}
                      </Link>
                    </td>
                    <td data-label="Tür">
                      <span className="customer-badge">
                        {customer.type === 'COMPANY' ? 'Kurumsal' : 'Bireysel'}
                      </span>
                    </td>
                    <td data-label="İletişim">
                      <span className="customer-contact-line">
                        {customer.email || 'E-posta belirtilmedi'}
                      </span>
                      <span className="customer-contact-line text-muted-foreground">
                        {customer.phone || 'Telefon belirtilmedi'}
                      </span>
                    </td>
                    <td data-label="Durum">
                      <span
                        className={`customer-badge ${customer.archivedAt ? '' : 'customer-badge-active'}`}
                      >
                        {customer.archivedAt ? 'Arşivlenmiş' : 'Aktif'}
                      </span>
                    </td>
                    <td>
                      <Link
                        className="customer-open"
                        to={`/customers/${encodeURIComponent(customer.id)}`}
                        aria-label={`${customer.displayName} profilini aç`}
                      >
                        <ArrowRight size={18} aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className="customer-pagination">
          <span>Sayfa {cursors.length} · Her sayfada en fazla 20 kayıt</span>
          <div>
            <Button
              variant="outline"
              disabled={loading || cursors.length === 1}
              onClick={() => setCursors((previous) => previous.slice(0, -1))}
            >
              Önceki sayfa
            </Button>
            <Button
              variant="outline"
              disabled={loading || !data?.hasMore || !data.nextCursor}
              onClick={() => {
                if (data?.nextCursor) setCursors((previous) => [...previous, data.nextCursor]);
              }}
            >
              Sonraki sayfa
            </Button>
          </div>
        </div>
      </Card>
      <p className="customer-legacy-hint">
        TCKN/VKN ile hassas arama ve diğer ileri işlemler için{' '}
        <Link to="/customers/legacy">klasik müşteri çalışma alanı</Link> kullanılabilir.
      </p>
    </div>
  );
}

import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';

import { Link, useLocation } from 'react-router';
import { ArrowRight, Plus, Search, Users } from 'lucide-react';
import { PageHeader } from '../../components/layout/PageContainer';
import { useListReturn } from '../../components/layout/use-list-return';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';
import { useCustomerResource } from './customer-resource';
import { CoverageBrief } from './CustomerCoverage';
import { useCustomerListContext } from './customer-list-context';
import { CustomerReferenceField } from './CustomerReferenceField';
import { customerListReadSchema } from './customer-read-schemas';

function listUrl(
  filter: { search: string; type: string; reference: string; referenceMembershipId: string },
  cursor?: string | null,
) {
  const params = new URLSearchParams({ limit: '20', include: 'coverage' });
  if (filter.search) params.set('search', filter.search);
  if (filter.type !== 'ALL') params.set('type', filter.type);
  if (filter.referenceMembershipId)
    params.set('referenceMembershipId', filter.referenceMembershipId);
  else if (filter.reference) params.set('reference', filter.reference);
  if (cursor) params.set('cursor', cursor);
  return `/api/customers?${params}`;
}

export default function CustomerListPage() {
  const memory = useCustomerListContext();
  const route = useLocation();
  const from: unknown = route.state?.listPositionKey;
  const saved =
    memory?.entries.get(route.key) ??
    (typeof from === 'string' ? memory?.entries.get(from) : undefined) ??
    memory?.current;
  const [search, setSearch] = useState(saved?.search ?? '');
  const [type, setType] = useState(saved?.type ?? 'ALL');
  const [reference, setReference] = useState(saved?.reference ?? '');
  const [referenceMembershipId, setReferenceMembershipId] = useState(
    saved?.referenceMembershipId ?? '',
  );
  const [filter, setFilter] = useState(
    saved?.filter ?? {
      search: '',
      type: 'ALL',
      reference: '',
      referenceMembershipId: '',
    },
  );
  const [cursors, setCursors] = useState<Array<string | null>>(saved?.cursors ?? [null]);
  useEffect(() => {
    if (memory)
      memory.current = {
        search,
        type,
        reference,
        referenceMembershipId,
        filter,
        cursors,
      };
  }, [memory, search, type, reference, referenceMembershipId, filter, cursors]);
  const url = listUrl(filter, cursors.at(-1));
  const { data, loading, error, reload } = useCustomerResource(url, customerListReadSchema);
  const { page, tableRegion, listPositionKey, rememberPosition } = useListReturn(!!data, url);
  function openProfile(event: MouseEvent<HTMLAnchorElement>) {
    if (!rememberPosition(event) || !memory) return;
    memory.entries.set(listPositionKey, {
      search,
      type,
      reference,
      referenceMembershipId,
      filter,
      cursors,
    });
    if (memory.entries.size > 10) memory.entries.delete(memory.entries.keys().next().value!);
  }
  function applyFilter(next: typeof filter) {
    setCursors([null]);
    setFilter(next);
    if (listUrl(next) === url) reload();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    applyFilter({
      search: search.trim(),
      type,
      reference: reference.trim(),
      referenceMembershipId,
    });
  }
  return (
    <div className="customer-modern" ref={page}>
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
        <search>
          <form className="customer-list-toolbar" onSubmit={submit} aria-label="Müşteri filtreleri">
            <CustomerReferenceField
              filtering
              membershipId={referenceMembershipId}
              name={reference}
              onChange={(id, name) => {
                setReferenceMembershipId(id);
                setReference(name);
              }}
            />
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
                setReference('');
                setReferenceMembershipId('');
                applyFilter({ search: '', type: 'ALL', reference: '', referenceMembershipId: '' });
              }}
            >
              Temizle
            </Button>
          </form>
        </search>
        {loading && (
          <div role="status" className="customer-state">
            Müşteriler yükleniyor…
          </div>
        )}
        {error && (
          <div role="alert" className="customer-state">
            <h2>{error.status === 403 ? 'Erişim izni gerekli' : 'Müşteriler yüklenemedi'}</h2>
            <p>{error.message}</p>
            {[400, 409].includes(error.status) && (
              <Button variant="outline" onClick={() => setCursors([null])}>
                İlk müşteri sayfasını yükle
              </Button>
            )}
            {error.status !== 403 && error.status !== 401 && ![400, 409].includes(error.status) && (
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
          <div ref={tableRegion}>
            <table className="customer-table customer-table-with-coverage">
              <caption className="sr-only">
                Müşteri listesi — yalnız erişiminiz olan kayıtlar
              </caption>
              <thead>
                <tr>
                  <th scope="col">Müşteri</th>
                  <th scope="col">Tür</th>
                  <th scope="col">Referans kişi</th>
                  <th scope="col">Sigortalar</th>
                  <th scope="col">İletişim</th>
                  <th scope="col">Durum</th>
                  <th scope="col">
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
                        state={{ listPositionKey }}
                        data-list-return-target={customer.id + ':name'}
                        onClick={openProfile}
                      >
                        {customer.displayName}
                      </Link>
                    </td>
                    <td data-label="Tür">
                      <span className="customer-badge">
                        {customer.type === 'COMPANY' ? 'Kurumsal' : 'Bireysel'}
                      </span>
                    </td>
                    <td data-label="Referans kişi">{customer.referenceName || 'Belirtilmedi'}</td>
                    <td data-label="Sigortalar" className="coverage-cell">
                      <CoverageBrief summary={customer.coverage} />
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
                        state={{ listPositionKey }}
                        data-list-return-target={customer.id + ':open'}
                        onClick={openProfile}
                      >
                        <ArrowRight size={18} aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
        <Link to="/customers/legacy">TCKN veya VKN ile ara</Link>
      </p>
    </div>
  );
}

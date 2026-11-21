import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  vehicleFieldsSchema,
  vehicleLabel,
  type CustomerVehicle,
  type VehiclePage,
} from '../../../shared/vehicles';
import type { CustomerDetailDto } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { useCustomerResource } from './customer-resource';
import { CustomerNumberGuard } from './CustomerNumberGuard';
import { useVehicleWrite } from './use-vehicle-write';
import {
  VehicleFieldsEditor,
  VehicleSummary,
  emptyVehicleDraft,
  vehicleDraft,
  vehicleInput,
} from './VehicleFields';
export function CustomerVehicles({
  customer,
  onReload,
  visible,
}: {
  customer: CustomerDetailDto;
  onReload: () => Promise<void>;
  visible: boolean;
}) {
  const root = `/api/customers/${encodeURIComponent(customer.id)}/vehicles`;
  const [after, setAfter] = useState(''),
    [rows, setRows] = useState<CustomerVehicle[]>([]);
  const page = useCustomerResource<VehiclePage>(
    root + (after ? '?after=' + encodeURIComponent(after) : ''),
  );
  useEffect(() => {
    if (Array.isArray(page.data?.items))
      setRows((old) =>
        after
          ? [...new Map([...old, ...page.data!.items].map((row) => [row.id, row])).values()]
          : [...page.data!.items],
      );
  }, [page.data, after]);
  const [editing, setEditing] = useState<CustomerVehicle | 'new' | null>(null),
    [draft, setDraft] = useState({ ...emptyVehicleDraft }),
    [active, setActive] = useState(true),
    [validation, setValidation] = useState('');
  const write = useVehicleWrite(async () => {
    await onReload();
    setAfter('');
    setRows([]);
    page.reload();
    setEditing(null);
    setValidation('');
  });
  const form = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    if (editing) form.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [editing]);
  function edit(vehicle: CustomerVehicle | 'new') {
    setEditing(vehicle);
    setDraft(vehicle === 'new' ? { ...emptyVehicleDraft } : vehicleDraft(vehicle.details));
    setActive(vehicle === 'new' || vehicle.status === 'ACTIVE');
    setValidation('');
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || write.locked || customer.archivedAt) return;
    const parsed = vehicleFieldsSchema.safeParse(vehicleInput(draft));
    if (!parsed.success || (parsed.data.modelYear ?? 0) > new Date().getFullYear() + 2) {
      setValidation('Plakayı, alan uzunluklarını ve model yılını kontrol edin.');
      return;
    }
    write.send(
      root + (editing === 'new' ? '' : '/' + encodeURIComponent(editing.id)),
      editing === 'new' ? 'POST' : 'PUT',
      {
        expectedVersion: customer.version,
        ...(editing === 'new' ? {} : { expectedVehicleVersion: editing.version }),
        details: parsed.data,
        status: active ? 'ACTIVE' : 'INACTIVE',
      },
    );
  }
  return (
    <>
      <CustomerNumberGuard
        label="Araç bilgisi"
        dirty={editing !== null}
        unresolved={write.unresolved}
      />
      <section
        className="customer-insurer-numbers customer-vehicles"
        aria-label="Müşterinin araçları"
        hidden={!visible}
      >
        <div className="customer-number-heading">
          <h2>Araçlar</h2>
          {!editing && !customer.archivedAt && (
            <Button variant="outline" onClick={() => edit('new')}>
              Araç ekle
            </Button>
          )}
        </div>
        <p>
          Araç bilgilerini elle kaydedin. Buradaki değişiklikler eski poliçelerin araç bilgilerini
          değiştirmez.
        </p>
        {page.loading && <p role="status">Araçlar yükleniyor…</p>}
        {page.error && <p role="alert">{page.error.message}</p>}
        {!page.loading && !page.error && !rows.length && <p>Henüz araç kaydedilmedi.</p>}
        {rows.map((row) => (
          <article className="vehicle-card" key={row.id} aria-label={vehicleLabel(row.details)}>
            <div className="customer-number-heading">
              <h3>
                {vehicleLabel(row.details)} · {row.status === 'ACTIVE' ? 'Aktif' : 'Pasif'}
              </h3>
              {!editing && !customer.archivedAt && (
                <Button
                  variant="outline"
                  aria-label={vehicleLabel(row.details) + ' aracını düzenle'}
                  onClick={() => edit(row)}
                >
                  Düzenle
                </Button>
              )}
            </div>
            <VehicleSummary details={row.details} />
          </article>
        ))}
        {page.data?.nextCursor && !editing && (
          <Button
            variant="outline"
            disabled={page.loading}
            onClick={() => setAfter(page.data!.nextCursor!)}
          >
            Diğer araçları göster
          </Button>
        )}
        {page.error && (
          <Button variant="outline" onClick={page.reload}>
            Araçları yeniden yükle
          </Button>
        )}
        {editing && (
          <form ref={form} method="post" action={root} aria-label="Araç kaydı" onSubmit={submit}>
            <VehicleFieldsEditor
              draft={draft}
              onChange={setDraft}
              disabled={write.locked || !!customer.archivedAt}
            />
            <label className="vehicle-active">
              <input
                type="checkbox"
                checked={active}
                disabled={write.locked || !!customer.archivedAt}
                onChange={(event) => setActive(event.target.checked)}
              />
              Aktif araç
            </label>
            {validation && <p role="alert">{validation}</p>}
            <div className="customer-form-actions">
              <Button type="submit" disabled={write.locked || !!customer.archivedAt}>
                Aracı kaydet
              </Button>
              <Button variant="ghost" disabled={write.locked} onClick={() => setEditing(null)}>
                Vazgeç
              </Button>
            </div>
          </form>
        )}
        {write.error && <p role="alert">{write.error}</p>}
        {write.message && <p role="status">{write.message}</p>}
        {write.busy && <p role="status">Araç bilgileri işleniyor…</p>}
        {write.pending && (
          <Button variant="outline" disabled={write.busy} onClick={write.retry}>
            Aynı araç kaydını yeniden dene
          </Button>
        )}
        {(write.saved || write.blocked) && (
          <Button variant="outline" disabled={write.busy} onClick={write.refresh}>
            Güncel araç bilgilerini yükle
          </Button>
        )}
      </section>
    </>
  );
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PolicyDetailDto } from '../../../shared/types';
import type { CustomerVehicle, VehiclePage } from '../../../shared/vehicles';
import { vehicleLabel } from '../../../shared/vehicles';
import { Button } from '../../components/ui/button';
import { CustomerNumberGuard } from '../customers/CustomerNumberGuard';
import { VehicleSummary } from '../customers/VehicleFields';
import { useCustomerResource } from '../customers/customer-resource';
import { readPolicyDetail } from './policy-read-schemas';
import { useVehicleWrite } from '../customers/use-vehicle-write';
export function PolicyVehicleSection({
  policy,
  onUpdated,
  visible,
}: {
  policy: PolicyDetailDto;
  onUpdated: (value: PolicyDetailDto) => void;
  visible: boolean;
}) {
  const [editing, setEditing] = useState(false),
    [selected, setSelected] = useState(''),
    [after, setAfter] = useState(''),
    [rows, setRows] = useState<CustomerVehicle[]>([]);
  const supportsVehicles = policy.branch?.supportsVehicleDetails === true;
  const canEdit = supportsVehicles && !policy.archivedAt;
  const select = useRef<HTMLSelectElement | null>(null);
  useEffect(() => {
    if (editing) select.current?.focus();
  }, [editing]);
  const page = useCustomerResource<VehiclePage>(
    editing && canEdit
      ? `/api/customers/${encodeURIComponent(policy.customerId)}/vehicles` +
          (after ? '?after=' + encodeURIComponent(after) : '')
      : null,
  );
  useEffect(() => {
    if (Array.isArray(page.data?.items))
      setRows((old) =>
        after
          ? [...new Map([...old, ...page.data!.items].map((row) => [row.id, row])).values()]
          : [...page.data!.items],
      );
  }, [page.data, after]);
  const write = useVehicleWrite(async (signal) => {
    const fresh = await readPolicyDetail(policy.id, signal);
    onUpdated(fresh);
    setEditing(false);
    page.reload();
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (write.locked || !canEdit) return;
    const vehicle = rows.find((row) => row.id === selected && row.status === 'ACTIVE');
    if (selected && !vehicle) return;
    write.send(`/api/policies/${encodeURIComponent(policy.id)}/vehicle`, 'PUT', {
      expectedVersion: policy.version,
      vehicleId: vehicle?.id ?? null,
      vehicleVersion: vehicle?.version ?? null,
    });
  }
  if (!supportsVehicles && !policy.vehicle && !editing && !write.unresolved) return null;
  return (
    <>
      <CustomerNumberGuard
        label="Poliçe araç bağlantısı"
        dirty={editing}
        unresolved={write.unresolved}
      />
      <section hidden={!visible} className="customer-insurer-numbers" aria-label="Poliçenin aracı">
        <div className="customer-number-heading">
          <h2>Poliçenin aracı</h2>
          {!editing && canEdit && (
            <Button
              variant="outline"
              onClick={() => {
                setSelected(policy.vehicle?.vehicleId ?? '');
                setEditing(true);
              }}
            >
              Araç seç / değiştir
            </Button>
          )}
        </div>
        <p>
          Bu poliçe dönemine kaydedilen bilgiler korunur. Müşteri kartındaki araç değişikliği buraya
          otomatik uygulanmaz.
        </p>
        {policy.vehicle ? (
          <VehicleSummary details={policy.vehicle.details} />
        ) : (
          <p>Bu poliçeye araç bağlanmadı.</p>
        )}
        {editing && !canEdit && !write.unresolved && (
          <Button variant="outline" onClick={() => setEditing(false)}>
            Vazgeç
          </Button>
        )}
        {editing && canEdit && (
          <form
            onSubmit={submit}
            action={`/api/policies/${encodeURIComponent(policy.id)}/vehicle`}
            method="post"
            aria-label="Poliçe aracı seçimi"
          >
            <fieldset disabled={write.locked || !!policy.archivedAt}>
              <legend>Bu dönemin aracı</legend>
              <label>
                Aracı seçin
                <select
                  ref={select}
                  name="vehicleId"
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  <option value="">Araç bağlantısı olmasın</option>
                  {policy.vehicle &&
                    !rows.some(
                      (row) => row.id === policy.vehicle!.vehicleId && row.status === 'ACTIVE',
                    ) && (
                      <option value={policy.vehicle.vehicleId} disabled>
                        {vehicleLabel(policy.vehicle.details)} · Mevcut tarihsel araç
                      </option>
                    )}
                  {rows
                    .filter((row) => row.status === 'ACTIVE')
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {vehicleLabel(row.details)} · {row.details.brand} {row.details.model}
                      </option>
                    ))}
                </select>
              </label>
              <p>Kaydet, seçilen aracın güncel bilgilerini bu poliçe dönemine kopyalar.</p>
              {rows.find((row) => row.id === selected) && (
                <VehicleSummary details={rows.find((row) => row.id === selected)!.details} />
              )}
              {page.loading && <p role="status">Araçlar yükleniyor…</p>}
              {page.error && <p role="alert">{page.error.message}</p>}
              {page.data?.nextCursor && (
                <Button variant="outline" onClick={() => setAfter(page.data!.nextCursor!)}>
                  Diğer araçları göster
                </Button>
              )}
              <Button variant="ghost" onClick={page.reload}>
                Araç listesini yeniden yükle
              </Button>
              <div className="customer-form-actions">
                <Button
                  type="submit"
                  disabled={(!selected && !policy.vehicle) || !!page.error || page.loading}
                >
                  Poliçenin aracını kaydet
                </Button>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Vazgeç
                </Button>
              </div>
            </fieldset>
          </form>
        )}
        {write.error && <p role="alert">{write.error}</p>}
        {write.message && <p role="status">{write.message}</p>}
        {write.busy && <p role="status">Araç bağlantısı kaydediliyor…</p>}
        {write.pending && (
          <Button variant="outline" disabled={write.busy} onClick={write.retry}>
            Aynı araç bağlantısını yeniden dene
          </Button>
        )}
        {(write.saved || write.blocked) && (
          <Button variant="outline" disabled={write.busy} onClick={write.refresh}>
            Poliçe bilgilerini yeniden yükle
          </Button>
        )}
      </section>
    </>
  );
}

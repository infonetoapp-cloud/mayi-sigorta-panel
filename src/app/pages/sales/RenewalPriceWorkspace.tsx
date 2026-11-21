import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { TodayTaskDto } from '../../../shared/types';
import { SalesPricesSection, type PriceRisk } from './SalesPricesSection';
import { RenewalSalesCaseAction } from './SalesCases';
import { useCustomerResource } from '../customers/customer-resource';
import { Button } from '../../components/ui/button';
const caseSchema = z
  .object({
    id: z.string().min(1),
    customerId: z.string().min(1),
    context: z.literal('RENEWAL'),
    renewalId: z.string().min(1),
    version: z.number().int().positive().safe(),
  })
  .passthrough();
const casesSchema = z.object({ items: z.array(caseSchema).max(1) }).passthrough();
export function RenewalPriceWorkspace({
  renewalId,
  customerId,
  active,
  canOperate,
  onRisk,
  readOnly = false,
}: {
  renewalId: string;
  customerId: string;
  active: boolean;
  canOperate: () => boolean;
  onRisk: (risk: PriceRisk) => void;
  readOnly?: boolean;
}) {
  const [visited, setVisited] = useState(active),
    [starting, setStarting] = useState(false),
    [saved, setSaved] = useState<string | null>(null);
  const root = `/api/sales-cases?renewalId=${encodeURIComponent(renewalId)}&result=ALL&limit=1`;
  const cases = useCustomerResource<unknown>(active || visited ? root : null);
  const found = casesSchema.safeParse(cases.data);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  const caseId =
    (found.success ? found.data.items : []).find(
      (c) => c.context === 'RENEWAL' && c.renewalId === renewalId && c.customerId === customerId,
    )?.id ?? saved;
  const detail = useCustomerResource<unknown>(
    caseId ? `/api/sales-cases/${encodeURIComponent(caseId)}` : null,
  );
  const current = caseSchema.safeParse(detail.data);
  const task = useCustomerResource<TodayTaskDto | null>(
    starting && !caseId ? `/api/renewals/${encodeURIComponent(renewalId)}/operation-context` : null,
  );
  if (!visited && !active) return null;
  return (
    <section aria-label="Yenileme şirket fiyatları">
      {cases.loading && <p role="status">Yenilemenin fiyat çalışması yükleniyor…</p>}
      {(cases.error || (!cases.loading && (active || visited) && !found.success && !saved)) && (
        <div role="alert">
          <p>Şirket fiyatları yüklenemedi.</p>
          <Button variant="outline" onClick={cases.reload}>
            Fiyat çalışmasını yeniden yükle
          </Button>
        </div>
      )}
      {caseId &&
      current.success &&
      current.data.id === caseId &&
      current.data.renewalId === renewalId &&
      current.data.customerId === customerId ? (
        <SalesPricesSection
          caseId={caseId}
          caseVersion={current.data.version}
          canOperate={canOperate}
          onChanged={detail.reload}
          onRisk={onRisk}
        />
      ) : (
        !cases.loading &&
        !cases.error &&
        found.success &&
        !caseId && (
          <div className="policy-lifecycle-summary">
            <h3>Şirket fiyatları</h3>
            <p>
              Bu yenilemenin fiyatlarını tek çalışma içinde karşılaştırın. Mevcut takip görevi
              korunur.
            </p>
            {readOnly && <p>Bu yenileme işlem için kapalıdır. Yeni fiyat çalışması açılamaz.</p>}
            {!starting && !readOnly && (
              <Button disabled={!canOperate()} onClick={() => setStarting(true)}>
                Fiyatları girmeye başla
              </Button>
            )}
            {starting && task.loading && <p role="status">Takip erişimi kontrol ediliyor…</p>}
            {starting && (task.error || (!task.loading && !task.data)) && (
              <p>
                Çalışmayı açmak için yenilemenin takip erişimi gerekli. Yetkili takip sorumlusu
                çalışmayı açtıktan sonra fiyatlar burada görülebilir.
              </p>
            )}
            {starting && !readOnly && task.data?.renewalId === renewalId && (
              <RenewalSalesCaseAction
                task={task.data}
                canOperate={canOperate}
                onRisk={onRisk}
                onOpened={(id) => {
                  onRisk({ dirty: false, unresolved: false });
                  setSaved(id);
                  cases.reload();
                }}
              />
            )}
          </div>
        )
      )}
      {caseId && detail.loading && <p role="status">Çalışma bilgisi yükleniyor…</p>}
      {caseId && (detail.error || (!detail.loading && !current.success)) && (
        <div role="alert">
          <p>Çalışma bilgisi okunamadı.</p>
          <Button variant="outline" onClick={detail.reload}>
            Çalışmayı yeniden yükle
          </Button>
        </div>
      )}
    </section>
  );
}

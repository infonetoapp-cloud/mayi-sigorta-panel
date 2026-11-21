import { useCallback, useRef, useState } from 'react';
import type { TodayTaskDto } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { readCustomerResource, useCustomerResource } from '../customers/customer-resource';
import { RenewalOutcomesSection } from '../today-work/RenewalOutcomesSection';
import { TaskOperationsSection, type TaskOperationRisk } from '../today-work/TaskOperationsSection';
import { RenewalSalesCaseAction } from '../sales/SalesCases';
export function RenewalActionWorkspace({
  renewalId,
  onRisk,
  canOperate,
  onApplied,
}: {
  renewalId: string;
  onRisk: (risk: TaskOperationRisk) => void;
  canOperate: () => boolean;
  onApplied: (message: string) => void;
}) {
  const url = `/api/renewals/${encodeURIComponent(renewalId)}/operation-context`,
    record = useCustomerResource<TodayTaskDto | null>(url);
  const [message, setMessage] = useState(''),
    risks = useRef({
      outcome: { dirty: false, unresolved: false },
      followup: { dirty: false, unresolved: false },
      admission: { dirty: false, unresolved: false },
    });
  const outcomeRisk = useCallback(
    (r: TaskOperationRisk) => {
      risks.current.outcome = r;
      onRisk({
        dirty: r.dirty || risks.current.followup.dirty || risks.current.admission.dirty,
        unresolved:
          r.unresolved || risks.current.followup.unresolved || risks.current.admission.unresolved,
      });
    },
    [onRisk],
  );
  const followupRisk = useCallback(
    (r: TaskOperationRisk) => {
      risks.current.followup = r;
      onRisk({
        dirty: r.dirty || risks.current.outcome.dirty || risks.current.admission.dirty,
        unresolved:
          r.unresolved || risks.current.outcome.unresolved || risks.current.admission.unresolved,
      });
    },
    [onRisk],
  );
  const admissionRisk = useCallback(
    (r: TaskOperationRisk) => {
      risks.current.admission = r;
      onRisk({
        dirty: risks.current.outcome.dirty || risks.current.followup.dirty || r.dirty,
        unresolved:
          risks.current.outcome.unresolved || risks.current.followup.unresolved || r.unresolved,
      });
    },
    [onRisk],
  );
  const task = record.data?.renewalId === renewalId ? record.data : null;
  const applied = (m: string) => {
    risks.current = {
      outcome: { dirty: false, unresolved: false },
      followup: { dirty: false, unresolved: false },
      admission: { dirty: false, unresolved: false },
    };
    onRisk({ dirty: false, unresolved: false });
    setMessage(m);
    record.reload();
    onApplied(m);
  };
  return (
    <section aria-label="Poliçelendirme ve takip">
      {message && <p role="status">{message}</p>}
      {record.loading && <p role="status">İşlem bilgileri yükleniyor…</p>}
      {record.error && (
        <div role="alert">
          <p>
            Bu yenilemeyi görüntüleyebilirsiniz; ilgili takip için işlem erişimi doğrulanamadı.
            Başka çalışanın takibi açılmadı.
          </p>
          <Button variant="outline" onClick={record.reload}>
            İşlem erişimini tekrar kontrol et
          </Button>
        </div>
      )}
      {!record.loading && !record.error && !task && (
        <p>İşlem yapılabilecek açık takip bulunmuyor.</p>
      )}
      {task && (
        <div key={task.taskId}>
          <RenewalOutcomesSection
            cycleEnabled
            task={task}
            read={async (signal) => {
              const fresh = await readCustomerResource<TodayTaskDto | null>(url, signal);
              return {
                current: fresh?.taskId === task.taskId ? fresh : undefined,
                apply: record.reload,
              };
            }}
            canOperate={() =>
              canOperate() &&
              !risks.current.followup.dirty &&
              !risks.current.followup.unresolved &&
              !risks.current.admission.unresolved
            }
            onRisk={outcomeRisk}
            onApplied={applied}
          />
          <details className="issue-followup">
            <summary>Poliçelendirilmedi — takipte bırak</summary>
            <p>
              Evrak, müşteri dönüşü veya fiyat revizyonu bekleniyorsa yenilemeyi kapatmayın. Nedeni
              ve sonraki takip zamanını kaydedin.
            </p>
            <TaskOperationsSection
              followupOnly
              task={task}
              read={async (signal) => {
                const fresh = await readCustomerResource<TodayTaskDto | null>(url, signal);
                return {
                  current: fresh?.taskId === task.taskId ? fresh : undefined,
                  apply: record.reload,
                };
              }}
              canOperate={() =>
                canOperate() &&
                !risks.current.outcome.dirty &&
                !risks.current.outcome.unresolved &&
                !risks.current.admission.unresolved
              }
              onRisk={followupRisk}
              onApplied={applied}
            />
          </details>
          <RenewalSalesCaseAction
            task={task}
            canOperate={() =>
              canOperate() &&
              !risks.current.outcome.dirty &&
              !risks.current.outcome.unresolved &&
              !risks.current.followup.dirty &&
              !risks.current.followup.unresolved
            }
            onRisk={admissionRisk}
          />
        </div>
      )}
    </section>
  );
}

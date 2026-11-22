import type { KeyboardEvent } from 'react';
import type { TodayTaskDto, WorkTaskDto } from '../../../shared/types';
import type { SalesTaskDto } from '../../../shared/sales';
import { Link, useLocation } from 'react-router';

const headings = {
  OVERDUE: 'Geciken takipler',
  TODAY: 'Bugünkü takipler',
  UPCOMING: 'Yaklaşan takipler',
} as const;
export const workQueueBuckets = Object.keys(headings) as Array<keyof typeof headings>;

export function WorkQueueTable({
  items,
  selectedId,
  timezone,
  onSelect,
  onKeyDown,
  register,
  onGeneralNavigate,
}: {
  items: readonly WorkTaskDto[];
  selectedId?: string;
  timezone: string;
  onSelect: (task: TodayTaskDto) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>, task: WorkTaskDto) => void;
  register: (id: string, node: HTMLElement | null) => void;
  onGeneralNavigate?: (task: SalesTaskDto) => void;
}) {
  const route = useLocation();
  const date = (value: string, withTime = false) =>
    new Intl.DateTimeFormat('tr-TR', {
      timeZone: timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      ...(withTime ? ({ hour: '2-digit', minute: '2-digit' } as const) : {}),
    }).format(new Date(value));
  return (
    <div className="work-queue-groups">
      {workQueueBuckets.map((bucket) => {
        const rows = items.filter((item) => item.bucket === bucket);
        return (
          <section
            key={bucket}
            className="work-group"
            data-bucket={bucket}
            aria-label={headings[bucket]}
          >
            <h3>
              <span className="work-group-marker" aria-hidden="true" />
              {headings[bucket]}{' '}
              <span className="work-group-count" aria-label={`${rows.length} yüklü takip`}>
                {rows.length}
              </span>
            </h3>
            {rows.length ? (
              <table className="work-queue-table">
                <caption className="sr-only">{headings[bucket]} — yüklenen kayıtlar</caption>
                <colgroup>
                  {[18, 17, 8, 14, 10, 12, 12, 9].map((width, index) => (
                    <col key={index} style={{ width: `${width}%` }} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Müşteri / Ünvan</th>
                    <th scope="col">İş konusu</th>
                    <th scope="col">Branş</th>
                    <th scope="col">Poliçe no</th>
                    <th scope="col">Poliçe bitişi</th>
                    <th scope="col">Takip zamanı</th>
                    <th scope="col">Durum</th>
                    <th scope="col">İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((task) =>
                    task.kind === 'GENERAL' ? (
                      <tr key={task.taskId}>
                        <td data-label="Müşteri / Ünvan">
                          <Link
                            className="customer-name"
                            ref={(node) => register(task.taskId, node)}
                            onKeyDown={(event) => onKeyDown(event, task)}
                            state={{ workReturn: route.key }}
                            onClick={() => onGeneralNavigate?.(task)}
                            to={
                              task.caseId
                                ? `/sales-cases/${encodeURIComponent(task.caseId)}`
                                : `/tasks/${encodeURIComponent(task.taskId)}`
                            }
                          >
                            {task.customerDisplayName}
                          </Link>
                        </td>
                        <td data-label="İş konusu">{task.title}</td>
                        <td data-label="Branş">{task.branchName ?? 'Genel takip'}</td>
                        <td data-label="Poliçe no" className="work-policy-placeholder">
                          —
                        </td>
                        <td data-label="Poliçe bitişi" className="work-policy-placeholder">
                          —
                        </td>
                        <td data-label="Takip zamanı">
                          <time dateTime={task.dueAt}>{date(task.dueAt, true)}</time>
                        </td>
                        <td data-label="Durum">
                          {bucket === 'OVERDUE'
                            ? 'Takip gecikti'
                            : bucket === 'TODAY'
                              ? 'Bugün'
                              : 'Planlandı'}
                        </td>
                        <td data-label="İşlem">
                          <Link
                            className="work-row-action"
                            state={{ workReturn: route.key }}
                            onClick={() => onGeneralNavigate?.(task)}
                            to={
                              task.caseId
                                ? `/sales-cases/${encodeURIComponent(task.caseId)}`
                                : `/tasks/${encodeURIComponent(task.taskId)}`
                            }
                          >
                            İşi aç ›
                          </Link>
                        </td>
                      </tr>
                    ) : (
                      <tr key={task.taskId} data-selected={task.taskId === selectedId}>
                        <td data-label="Müşteri">
                          <button
                            type="button"
                            className="today-task-row"
                            ref={(node) => register(task.taskId, node)}
                            aria-pressed={task.taskId === selectedId}
                            aria-label={`${task.customerDisplayName} ${task.title}`}
                            onKeyDown={(event) => onKeyDown(event, task)}
                            onClick={() => onSelect(task)}
                          >
                            <strong>{task.customerDisplayName}</strong>
                          </button>
                        </td>
                        <td data-label="İş konusu">{task.title}</td>
                        <td data-label="Branş">
                          <span
                            className="work-branch"
                            data-branch={task.policyBranchName?.toLocaleLowerCase('tr-TR')}
                          >
                            {task.policyBranchName ?? 'Belirtilmedi'}
                          </span>
                        </td>
                        <td data-label="Poliçe no">{task.policyNumber ?? '—'}</td>
                        <td data-label="Poliçe bitişi">
                          {task.policyEndDate ? (
                            <time dateTime={task.policyEndDate}>
                              {date(task.policyEndDate + 'T12:00:00Z')}
                            </time>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td data-label="Takip zamanı">
                          <time dateTime={task.dueAt}>{date(task.dueAt, true)}</time>
                        </td>
                        <td data-label="Durum">
                          <span className="work-state">
                            {bucket === 'OVERDUE'
                              ? 'Takip gecikti'
                              : bucket === 'TODAY'
                                ? 'Bugün'
                                : 'Planlandı'}
                          </span>
                        </td>
                        <td data-label="İşlem">
                          <button
                            className="work-row-action"
                            type="button"
                            onClick={() => onSelect(task)}
                          >
                            İşlem <span aria-hidden="true">›</span>
                          </button>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            ) : (
              <p className="work-group-empty">Bu grupta yüklü takip yok.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

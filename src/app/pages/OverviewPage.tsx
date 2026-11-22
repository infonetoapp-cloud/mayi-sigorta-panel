import { Link } from 'react-router';
import { Activity, ArrowRight, FileCheck2, RefreshCw, UserCog, Users } from 'lucide-react';
import { Button } from '../components/ui/button';
import { useCustomerResource } from './customers/customer-resource';
import { taskQueueReadSchema } from './today-work/task-queue-read-schema';
import { workUrl } from './today-work/work-navigation';
import type { UnifiedTodayTasksResponseData } from '../../shared/types';

const quickLinks = [
  { to: '/customers', label: 'Müşterilere git', icon: Users },
  { to: '/renewals', label: 'Yenilemeleri incele', icon: RefreshCw },
  { to: '/policies', label: 'Poliçelere git', icon: FileCheck2 },
];

function priorityTaskUrl(task: UnifiedTodayTasksResponseData['items'][number]) {
  if (task.kind !== 'GENERAL') return workUrl(task.taskId, 'WORK');
  return task.caseId
    ? `/sales-cases/${encodeURIComponent(task.caseId)}`
    : `/tasks/${encodeURIComponent(task.taskId)}`;
}

export default function OverviewPage({ owner }: { owner: boolean }) {
  const { data, error, reload } = useCustomerResource(
    '/api/tasks/today?limit=20' + (owner ? '&unified=true' : ''),
    taskQueueReadSchema,
  );
  const priorities = data?.items.filter((task) => task.bucket !== 'UPCOMING').slice(0, 4);
  const dueDate = data
    ? new Intl.DateTimeFormat('tr-TR', {
        timeZone: data.timezone,
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : undefined;

  return (
    <div className="overview-grid">
      <section className="overview-panel" aria-labelledby="overview-tasks">
        <header className="overview-panel-header">
          <h2 id="overview-tasks">Öncelikli takipler</h2>
          <Button asChild>
            <Link to="/today-work">
              Bugünkü işleri aç <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </header>
        {error ? (
          <div className="overview-feedback">
            <p role="alert">Takipler yüklenemedi.</p>
            <Button variant="outline" onClick={reload}>
              Yeniden dene
            </Button>
          </div>
        ) : !data ? (
          <p className="overview-feedback" role="status">
            Takipler yükleniyor…
          </p>
        ) : priorities?.length ? (
          <ul className="overview-priorities">
            {priorities.map((task) => (
              <li key={task.taskId}>
                <div>
                  <Link to={priorityTaskUrl(task)} className="overview-priority-link">
                    <strong>{task.customerDisplayName}</strong>
                    <span>{task.title}</span>
                  </Link>
                </div>
                <div className="overview-due">
                  <span className="overview-status" data-overdue={task.bucket === 'OVERDUE'}>
                    {task.bucket === 'OVERDUE' ? 'Gecikti' : 'Bugün'}
                  </span>
                  <time dateTime={task.dueAt}>{dueDate?.format(new Date(task.dueAt))}</time>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="overview-feedback">Gecikmiş veya bugün yapılacak takip görünmüyor.</p>
        )}
      </section>
      <nav className="overview-panel" aria-labelledby="overview-shortcuts">
        <header className="overview-panel-header">
          <h2 id="overview-shortcuts">Hızlı erişim</h2>
        </header>
        <ul className="overview-shortcuts">
          {quickLinks.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <Link to={to}>
                <Icon aria-hidden="true" /> {label}
              </Link>
            </li>
          ))}
          {owner && (
            <>
              <li>
                <Link to="/personnel">
                  <UserCog aria-hidden="true" /> Personel ve izinleri yönet
                </Link>
              </li>
              <li>
                <Link to="/ops/readiness">
                  <Activity aria-hidden="true" /> İşletim durumu
                </Link>
              </li>
            </>
          )}
        </ul>
      </nav>
    </div>
  );
}

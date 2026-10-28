import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { TodayTasksResponseData, PolicyListResponseData } from '../../../shared/types';
import type { TaskStatisticsData } from '../../../shared/task-statistics';
import { useCustomerResource } from '../customers/customer-resource';
import { expirationRange } from '../policies/policy-portfolio';
import { policyDate } from '../policies/policy-display';
import { PageHeader } from '../../components/layout/PageContainer';
import { Card, CardHeader, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { WorkflowHelp } from '../../components/ui/workflow-help';
const dueLabels = {
  ALL: 'Tüm takipler',
  OVERDUE: 'Geciken takipler',
  TODAY: 'Bugünkü takipler',
  UPCOMING: 'Yaklaşan takipler',
} as const;
type Due = keyof typeof dueLabels;
function dueOf(value: string | null): Due {
  return value === 'ALL' || value === 'OVERDUE' || value === 'UPCOMING' ? value : 'TODAY';
}
function stamp(value: string) {
  try {
    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: 'Europe/Istanbul',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return 'Tarih kullanılamıyor';
  }
}
function Summary({ owner }: { owner: boolean }) {
  const view = owner ? 'team' : 'self';
  const state = useCustomerResource<TaskStatisticsData>('/api/tasks/statistics?view=' + view);
  const data = state.data;
  const valid =
    data &&
    data.view === view &&
    data.timezone === 'Europe/Istanbul' &&
    (!owner || data.canSeeTeam) &&
    [
      data.summary?.overdue,
      data.summary?.dueToday,
      data.summary?.upcoming,
      data.summary?.completedLast30Days,
    ].every((n) => Number.isSafeInteger(n) && n >= 0);
  return (
    <Card className="dashboard-summary">
      <CardHeader>
        <h2>Görev özeti</h2>
        <p>
          {owner ? 'Acente genelinde yetkili olduğunuz işler' : 'Yalnız size ait işler'} · İstanbul
          takvim günü
        </p>
      </CardHeader>
      <CardContent>
        {state.loading && <p role="status">Görev özeti yükleniyor…</p>}
        {(state.error || (!state.loading && !valid)) && (
          <div role="alert">
            <p>Görev özeti kullanılamıyor.</p>
            <p>{state.error?.message ?? 'Bilgiler doğrulanamadı.'}</p>
            <Button variant="outline" onClick={state.reload}>
              Özeti yeniden yükle
            </Button>
          </div>
        )}
        {valid && (
          <>
            <p>Son okuma: {stamp(data.now)}</p>
            <div className="dashboard-metrics">
              {(
                [
                  ['Geciken görevler', data.summary.overdue, 'OVERDUE'],
                  ['Bugünkü görevler', data.summary.dueToday, 'TODAY'],
                  ['Yaklaşan görevler', data.summary.upcoming, 'UPCOMING'],
                ] as const
              ).map(([label, count, due]) => (
                <Link
                  key={due}
                  to={`/?followup=${due}#renewal-followups`}
                  aria-label={`${label}: ${count}`}
                >
                  <span>{label}</span>
                  <strong>{count}</strong>
                </Link>
              ))}
              {owner && data.unassigned && (
                <Link
                  to="/?followup=ALL&unassigned=true#renewal-followups"
                  aria-label={`Atanmamış görevler: ${data.unassigned.overdue + data.unassigned.dueToday + data.unassigned.upcoming}`}
                >
                  <span>Atanmamış görevler</span>
                  <strong>
                    {data.unassigned.overdue + data.unassigned.dueToday + data.unassigned.upcoming}
                  </strong>
                </Link>
              )}
            </div>
            <WorkflowHelp title="Özetin kapsamı">
              Sayılar tüm görev türlerini kapsar. Aşağıdaki liste yenileme takipleridir; sayfa
              uzunluğu toplam görev sayısı değildir.
              {owner ? ' Atanmamış işler acente toplamına dahildir.' : ''}
            </WorkflowHelp>
          </>
        )}
      </CardContent>
    </Card>
  );
}
function Followups({ owner }: { owner: boolean }) {
  const [params, setParams] = useSearchParams();
  const due = dueOf(params.get('followup'));
  const unassigned = params.get('unassigned') === 'true';
  const cursor = params.get('after');
  const query = new URLSearchParams({ limit: '5' });
  if (due !== 'ALL') query.set('due', due);
  if (cursor) query.set(unassigned ? 'unassignedCursor' : 'cursor', cursor);
  const state = useCustomerResource<TodayTasksResponseData>('/api/tasks/today?' + query);
  const data = state.data;
  const permitted = !unassigned || (owner && data?.canSeeUnassigned === true);
  const items = data && permitted ? (unassigned ? data.unassignedItems : data.items) : [];
  const next =
    data && (unassigned ? data.unassignedHasMore : data.hasMore)
      ? unassigned
        ? data.unassignedNextCursor
        : data.nextCursor
      : null;
  function choose(value: Due, queue = unassigned) {
    const p = new URLSearchParams(params);
    p.set('followup', value);
    p.delete('after');
    if (queue) p.set('unassigned', 'true');
    else p.delete('unassigned');
    setParams(p);
  }
  return (
    <Card id="renewal-followups">
      <CardHeader>
        <h2>Yenileme takipleri</h2>
        <p>Öncelikli kayıtlar, her sayfada en fazla 5 takip.</p>
      </CardHeader>
      <CardContent>
        <div className="dashboard-actions" role="group" aria-label="Takip tarih aralığı">
          {(Object.keys(dueLabels) as Due[]).map((d) => (
            <Button
              key={d}
              variant="outline"
              aria-label={dueLabels[d]}
              aria-pressed={due === d}
              onClick={() => choose(d)}
            >
              {{ ALL: 'Tümü', OVERDUE: 'Geciken', TODAY: 'Bugün', UPCOMING: 'Planlı' }[d]}
            </Button>
          ))}
        </div>
        {owner && data?.canSeeUnassigned && (
          <div className="dashboard-actions" role="group" aria-label="Takip kapsamı">
            <Button variant="ghost" aria-pressed={!unassigned} onClick={() => choose(due, false)}>
              Atanmış takipler
            </Button>
            <Button variant="ghost" aria-pressed={unassigned} onClick={() => choose(due, true)}>
              Atanmamış takipler
            </Button>
          </div>
        )}
        <WorkflowHelp title="Takip tarihleri hakkında">
          Geciken: dünden ve öncesinden kalan işler. Bugün: günün tamamı; saati geçmiş bugünkü işler
          de burada yer alır.
        </WorkflowHelp>
        {state.loading && <p role="status">Takipler yükleniyor…</p>}
        {state.error && (
          <div role="alert">
            <p>Takipler kullanılamıyor.</p>
            <p>{state.error.message}</p>
            <Button variant="outline" onClick={state.reload}>
              Takipleri yeniden yükle
            </Button>
          </div>
        )}
        {data && !permitted && <p role="alert">Atanmamış takipleri görüntüleme yetkiniz yok.</p>}
        {data && permitted && (
          <>
            {!items.length ? (
              <p>Bu tarih aralığında gösterilecek yenileme takibi yok.</p>
            ) : (
              <ul className="dashboard-records">
                {items.map((t) => (
                  <li key={t.taskId}>
                    <Link
                      to={
                        '/today-work?' +
                        new URLSearchParams({
                          task: t.taskId,
                          queue: unassigned ? 'UNASSIGNED' : 'WORK',
                        })
                      }
                    >
                      {t.customerDisplayName} · {t.policyNumber ?? 'Yenileme takibi'}
                    </Link>
                    <span>{stamp(t.dueAt)}</span>
                    <span>
                      {t.renewalState === 'AWAITING_RESPONSE'
                        ? 'Müşteri yanıtı bekleniyor'
                        : t.renewalState === 'QUOTE_SENT'
                          ? 'Teklif gönderildi'
                          : 'Takip bekliyor'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="dashboard-actions">
              <Button
                variant="outline"
                disabled={!cursor}
                onClick={() => {
                  const p = new URLSearchParams(params);
                  p.delete('after');
                  setParams(p);
                }}
              >
                İlk takip sayfası
              </Button>
              <Button
                variant="outline"
                disabled={!next || state.loading}
                onClick={() => {
                  if (next) {
                    const p = new URLSearchParams(params);
                    p.set('after', next);
                    setParams(p);
                  }
                }}
              >
                Sonraki takipler
              </Button>
            </div>
          </>
        )}
        <Link to="/today-work">Tüm iş kuyruğunu aç</Link>
      </CardContent>
    </Card>
  );
}
function Expirations() {
  const [params, setParams] = useSearchParams();
  const horizon = params.get('horizon') === '30' ? 30 : 7;
  const range = expirationRange(horizon);
  const filter = new URLSearchParams({
    status: 'ACTIVE',
    endFrom: range.endFrom,
    endTo: range.endTo,
    sort: 'end_date_asc',
  });
  const state = useCustomerResource<PolicyListResponseData>(
    '/api/policies?' + filter + '&includeLabels=true&pageSize=5',
  );
  return (
    <Card>
      <CardHeader>
        <h2>Yaklaşan poliçe vadeleri</h2>
        <p>Türkiye saatine göre bugün dahil {horizon} gün · İlk 5 yetkili kayıt</p>
      </CardHeader>
      <CardContent>
        <div className="dashboard-actions" role="group" aria-label="Poliçe vade aralığı">
          {([7, 30] as const).map((d) => (
            <Button
              key={d}
              variant="outline"
              aria-pressed={horizon === d}
              onClick={() => {
                const p = new URLSearchParams(params);
                p.set('horizon', String(d));
                setParams(p);
              }}
            >
              {d} günlük vadeler
            </Button>
          ))}
        </div>
        {state.loading && <p role="status">Vadeler yükleniyor…</p>}
        {state.error && (
          <div role="alert">
            <p>Vadeler kullanılamıyor.</p>
            <p>{state.error.message}</p>
            <Button variant="outline" onClick={state.reload}>
              Vadeleri yeniden yükle
            </Button>
          </div>
        )}
        {state.data && (
          <>
            {!state.data.items.length ? (
              <p>Bu aralıkta görüntülenebilir aktif poliçe yok.</p>
            ) : (
              <ul className="dashboard-records">
                {state.data.items.map((p) => (
                  <li key={p.id}>
                    <Link
                      to={'/policies/' + encodeURIComponent(p.id)}
                      state={{ policyListReturn: '/policies?' + filter }}
                    >
                      {p.policyNumber}
                    </Link>
                    <span>{policyDate(p.endDate)}</span>
                    {p.labels && (
                      <span>
                        {p.labels.insurerName} · {p.labels.productName} · {p.labels.branchName}
                      </span>
                    )}
                    {p.archivedAt && <span>Arşivlenmiş · Tarihsel kayıt</span>}
                  </li>
                ))}
              </ul>
            )}
            {state.data.hasMore && (
              <p>Daha fazla sonuç var; liste toplam portföy sayısı değildir.</p>
            )}
          </>
        )}
        <Link to={'/policies?' + filter}>Bu aralıktaki poliçeleri aç</Link>
      </CardContent>
    </Card>
  );
}
function Panels({ owner }: { owner: boolean }) {
  return (
    <div className="dashboard-panels">
      <Summary owner={owner} />
      <Followups owner={owner} />
      <Expirations />
    </div>
  );
}
export function OperationalDashboard({ owner }: { owner: boolean }) {
  const [revision, setRevision] = useState(0);
  const [day, setDay] = useState(() => expirationRange(1).endFrom);
  useEffect(() => {
    const refresh = () => {
      setDay(expirationRange(1).endFrom);
      setRevision((r) => r + 1);
    };
    const midnight = setInterval(() => setDay(expirationRange(1).endFrom), 60000);
    addEventListener('focus', refresh);
    return () => {
      clearInterval(midnight);
      removeEventListener('focus', refresh);
    };
  }, []);
  return (
    <div className="operational-dashboard">
      <PageHeader
        title="Genel Bakış"

        action={
          <Button
            variant="outline"
            onClick={() => {
              setDay(expirationRange(1).endFrom);
              setRevision((r) => r + 1);
            }}
          >
            Bilgileri yenile
          </Button>
        }
      />
      <p>İş günü: {policyDate(day)} · Europe/Istanbul</p>
      <Panels key={`${owner}:${day}:${revision}`} owner={owner} />
      <nav className="dashboard-actions" aria-label="Hızlı erişim">
        <Link to="/customers">Müşteriler</Link>
        <Link to="/policies">Poliçe portföyü</Link>
        <Link to="/today-work">Bugünkü işler</Link>
        {owner && <Link to="/personnel">Personel ve izinler</Link>}
      </nav>
    </div>
  );
}

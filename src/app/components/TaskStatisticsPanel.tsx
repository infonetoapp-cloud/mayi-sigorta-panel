import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResponse } from '../../shared/types';
import type { TaskStatisticsCounts, TaskStatisticsData } from '../../shared/task-statistics';

function Counts({ counts }: { readonly counts: TaskStatisticsCounts }) {
  return (
    <dl style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', margin: '0.5rem 0' }}>
      {(
        [
          ['Geciken', counts.overdue],
          ['Bugün', counts.dueToday],
          ['Yaklaşan', counts.upcoming],
          ['Son 30 günde tamamlanan', counts.completedLast30Days],
        ] as const
      ).map(([label, count]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd style={{ margin: 0, fontWeight: 700 }}>{count}</dd>
        </div>
      ))}
    </dl>
  );
}
function Statistics({ refreshKey }: { readonly refreshKey: number }) {
  const [view, setView] = useState<'self' | 'team'>('self');
  const [data, setData] = useState<TaskStatisticsData | null>(null);
  const [canSeeTeam, setCanSeeTeam] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(
    async (cursor: string | null) => {
      const request = ++generation.current;
      setLoading(true);
      setError(null);
      setFailedCursor(cursor);
      if (!cursor) setData(null);
      let status = 0;
      try {
        const parameters = new URLSearchParams();
        if (view === 'team') parameters.set('view', 'team');
        if (cursor) parameters.set('cursor', cursor);
        const query = parameters.toString();
        const response = await fetch(`/api/tasks/statistics${query ? `?${query}` : ''}`, {
          method: 'GET',
          cache: 'no-store',
        });
        status = response.status;
        if (!response.ok) throw new Error('STATISTICS_UNAVAILABLE');
        const body = (await response.json()) as ApiResponse<TaskStatisticsData>;
        if (!body.success || body.data.view !== view) throw new Error('STATISTICS_UNAVAILABLE');
        if (request !== generation.current) return;
        setCanSeeTeam(body.data.canSeeTeam);
        setData((previous) =>
          cursor && previous?.view === view
            ? {
                ...body.data,
                employees: [
                  ...previous.employees,
                  ...body.data.employees.filter(
                    (row) =>
                      !previous.employees.some((old) => old.membershipId === row.membershipId),
                  ),
                ],
              }
            : body.data,
        );
        setFailedCursor(null);
      } catch {
        if (request !== generation.current) return;
        const denied = [401, 403, 404].includes(status);
        if (!cursor || denied) setData(null);
        if (denied) {
          setCanSeeTeam(false);
          setFailedCursor(null);
        }
        setError(
          'Görev istatistikleri yüklenemedi. Oturum ve yetkinizi denetleyip yeniden deneyin.',
        );
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [view],
  );
  useEffect(() => {
    void load(null);
    return () => {
      generation.current++;
    };
  }, [load, refreshKey]);
  const visible = data?.view === view ? data : null;
  return (
    <section
      aria-label="Görev istatistikleri"
      style={{ border: '1px solid #e2e8f0', borderRadius: '0.5rem', padding: '1rem' }}
    >
      <h3>Görev istatistikleri</h3>
      <p>
        Güncel atanmış iş yükü ile tamamlayan çalışanın faaliyeti ayrı ölçülür. Görev sayısıdır;
        müşteri veya yenileme sayısı değildir.
      </p>
      {canSeeTeam && (
        <nav aria-label="İstatistik kapsamı">
          <button type="button" aria-pressed={view === 'self'} onClick={() => setView('self')}>
            Kendi özetim
          </button>{' '}
          <button type="button" aria-pressed={view === 'team'} onClick={() => setView('team')}>
            Ekip özeti
          </button>
        </nav>
      )}
      {loading && <p role="status">İstatistikler yükleniyor…</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={loading} onClick={() => void load(failedCursor)}>
        {error ? 'İstatistikleri yeniden dene' : 'İstatistikleri yenile'}
      </button>
      {visible && (
        <>
          <p>
            Europe/Istanbul · İş günü: {visible.todayLocalDate} · Hesaplama:{' '}
            {new Intl.DateTimeFormat('tr-TR', {
              timeZone: 'Europe/Istanbul',
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(visible.now))}
          </p>
          <h4>{view === 'team' ? 'Tüm ekip (atanmamış dahil)' : 'Kendi görev özetim'}</h4>
          <Counts counts={visible.summary} />
          <details>
            <summary>Metrik tanımları ve kapsam</summary>
            <p>
              Güncel atanmış iş yükü: Geciken, bugünün 00:00 sınırından önce vadeli açık görevler;
              bugün, 00:00–ertesi gün 00:00 aralığı; yaklaşan, ertesi gün ve sonrası. İş listesi ise
              geçmiş saatli takipleri de gecikmiş gösterebilir.
            </p>
            <p>
              Tamamlayan çalışana göre: Bugün dahil son 30 İstanbul takvim gününde, hesaplama anına
              kadar tamamlanan görevler. Başlangıç:{' '}
              {new Intl.DateTimeFormat('tr-TR', {
                timeZone: 'Europe/Istanbul',
                dateStyle: 'medium',
              }).format(new Date(visible.completionStart))}{' '}
              00:00. Güncel sorumlu değil, kaydedilmiş tamamlayan esas alınır.
            </p>
            <p>
              Yalnız mevcut kayıt ve hassasiyet izinleri kapsamındaki görevler sayılır. Açık işlerde
              arşivli müşteri/poliçe, aktif olmayan poliçe ve kapanmış yenileme dışarıdadır.
              Tamamlanan faaliyet geçmişi, kayıt sonradan arşivlense veya personel pasifleşse de
              yetki kapsamındaysa korunur. Atama değişikliği geçmiş tamamlayanı değiştirmez.
            </p>
          </details>
          {view === 'team' && (
            <>
              <h4>Çalışan bazında</h4>
              {visible.employees.map((employee) => (
                <article
                  key={employee.membershipId}
                  aria-label={employee.displayName ?? 'Çalışan adı mevcut değil'}
                  style={{ borderTop: '1px solid #e2e8f0', padding: '0.5rem 0' }}
                >
                  <h5>
                    {employee.displayName ?? 'Çalışan adı mevcut değil'} ·{' '}
                    {employee.status === 'SUSPENDED'
                      ? 'Askıda'
                      : employee.status === 'INACTIVE'
                        ? 'Pasif'
                        : employee.status === 'INVITED'
                          ? 'Davetli'
                          : 'Aktif'}
                    {!employee.userActive && ' · Kullanıcı pasif'}
                  </h5>
                  {(employee.status !== 'ACTIVE' || !employee.userActive) && (
                    <p>
                      Açık işler bu kişide korunur; yeniden atama gerekir. Tamamlanmış faaliyet
                      geçmişi korunur.
                    </p>
                  )}
                  <Counts counts={employee} />
                </article>
              ))}
              {visible.employees.length === 0 && <p>Bu sayfada çalışan yok.</p>}
              {visible.unassigned && (
                <>
                  <h4>Atanmamış açık işler (ekip toplamına dahil)</h4>
                  <p>
                    Geciken: {visible.unassigned.overdue} · Bugün: {visible.unassigned.dueToday} ·
                    Yaklaşan: {visible.unassigned.upcoming}
                  </p>
                </>
              )}
              {visible.nextCursor && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void load(visible.nextCursor)}
                >
                  Diğer çalışanları göster
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
export function TaskStatisticsPanel({ refreshKey }: { readonly refreshKey: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Görev istatistiklerini gizle' : 'Görev istatistiklerini göster'}
      </button>
      {open && <Statistics refreshKey={refreshKey} />}
    </div>
  );
}

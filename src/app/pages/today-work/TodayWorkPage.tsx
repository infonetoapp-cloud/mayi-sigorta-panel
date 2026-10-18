import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import type { RenewalStateCode, TodayTaskDto } from '../../../shared/types';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { TaskStatisticsPanel } from '../../components/TaskStatisticsPanel';
import { useTaskQueue, type WorkQueue } from './use-task-queue';

const states: Record<RenewalStateCode, string> = {
  CONTACT_PENDING: 'İletişim bekleniyor',
  CONTACTED: 'Görüşüldü',
  QUOTE_PREPARING: 'Teklif hazırlanıyor',
  QUOTE_SENT: 'Teklif gönderildi',
  AWAITING_RESPONSE: 'Yanıt bekleniyor',
  WON: 'Yenilendi',
  LOST: 'Yenilenmedi',
  VOIDED: 'Geçersiz',
};
function due(value: string, timezone: string, dateOnly = false) {
  try {
    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: timezone,
      dateStyle: 'medium',
      ...(!dateOnly ? { timeStyle: 'short' as const } : {}),
    }).format(new Date(value));
  } catch {
    return 'Tarih kullanılamıyor';
  }
}
function Workspace({ owner }: { owner: boolean }) {
  const queue = useTaskQueue(owner),
    [selection, setSelection] = useState<{
      id: string;
      queue: WorkQueue;
      authority: number;
    } | null>(null);
  const overview = useRef<HTMLHeadingElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    returnFocus = useRef(false),
    buttons = useRef(new Map<string, HTMLButtonElement>());
  const items = queue.data
    ? queue.view === 'UNASSIGNED'
      ? queue.data.unassignedItems
      : queue.data.items
    : [];
  const selected =
    selection?.queue === queue.view && selection.authority === queue.authority
      ? items.find((task) => task.taskId === selection.id)
      : undefined;
  useEffect(() => {
    if (selected) overview.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      heading.current?.focus();
    }
  }, [selected]);
  function change(next: WorkQueue) {
    if (next !== queue.view) {
      setSelection(null);
      queue.change(next);
    }
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, task: TodayTaskDto) {
    const index = items.findIndex((row) => row.taskId === task.taskId);
    const next =
      event.key === 'ArrowDown'
        ? Math.min(index + 1, items.length - 1)
        : event.key === 'ArrowUp'
          ? Math.max(index - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      const row = items[next];
      if (row) buttons.current.get(row.taskId)?.focus();
    }
  }
  const hasMore = queue.view === 'UNASSIGNED' ? queue.data?.unassignedHasMore : queue.data?.hasMore;
  return (
    <div className="today-modern">
      <PageHeader
        title="Bugünkü İşler"
        description="Yetkili iş kuyruğunuzdan bir takip seçin. İşlemler klasik çalışma alanında sürer."
      />
      <div className="today-toolbar">
        <nav aria-label="İş kuyrukları">
          <Button
            variant={queue.view === 'WORK' ? 'default' : 'outline'}
            aria-pressed={queue.view === 'WORK'}
            onClick={() => change('WORK')}
          >
            {owner ? 'Açık işler' : 'Kendi işlerim'}
          </Button>
          {queue.canSeeUnassigned && (
            <Button
              variant="outline"
              aria-pressed={queue.view === 'UNASSIGNED'}
              onClick={() => change('UNASSIGNED')}
            >
              Atanmamış işler
            </Button>
          )}
          {queue.canSeeReassignment && (
            <Button
              variant="outline"
              aria-pressed={queue.view === 'REASSIGNMENT'}
              onClick={() => change('REASSIGNMENT')}
            >
              Yeniden atama gerekenler
            </Button>
          )}
        </nav>
        <Button
          variant="outline"
          onClick={() => {
            setSelection(null);
            queue.refresh();
          }}
        >
          Listeyi yenile
        </Button>
        <Button variant="outline" asChild>
          <Link to="/today-work/legacy">Klasik çalışma alanı</Link>
        </Button>
      </div>
      {queue.loading && <p role="status">Görevler yükleniyor…</p>}
      {queue.failure && (
        <div role="alert">
          <p>{queue.failure.message}</p>
          <Button variant="outline" disabled={!!queue.loading} onClick={queue.retry}>
            Aynı sayfayı yeniden dene
          </Button>
        </div>
      )}
      {queue.data && (
        <>
          <p className="today-clock">
            {queue.data.timezone} · İş günü: {queue.data.todayLocalDate} · Saatler sunucunun zaman
            dilimindedir. Gruplar görev vade anına; istatistikler İstanbul takvim gününe göre
            hesaplanır.
          </p>
          {queue.view === 'REASSIGNMENT' && (
            <p>
              Etkin olmayan veya askıya alınmış sorumlulardaki açık takipler. Tarihsel atama
              korunur; otomatik atama yapılmaz.
            </p>
          )}
          <div className="today-workspace" data-selected={!!selected}>
            <Card className="today-queue" aria-label="Görev kuyruğu">
              <CardHeader>
                <CardTitle>
                  <span ref={heading} tabIndex={-1}>
                    {queue.view === 'WORK'
                      ? owner
                        ? 'Açık işler'
                        : 'Kendi işlerim'
                      : queue.view === 'UNASSIGNED'
                        ? 'Atanmamış işler'
                        : 'Yeniden atama gerekenler'}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {(['OVERDUE', 'TODAY', 'UPCOMING'] as const).map((bucket, index) => (
                  <section
                    key={bucket}
                    aria-label={
                      ['Geciken takipler', 'Bugünkü takipler', 'Yaklaşan takipler'][index]
                    }
                  >
                    <h3>{['Geciken takipler', 'Bugünkü takipler', 'Yaklaşan takipler'][index]}</h3>
                    <ul className="today-task-list">
                      {items
                        .filter((item) => item.bucket === bucket)
                        .map((task) => (
                          <li key={task.taskId}>
                            <button
                              type="button"
                              ref={(node) => {
                                if (node) buttons.current.set(task.taskId, node);
                                else buttons.current.delete(task.taskId);
                              }}
                              className="today-task-row"
                              aria-pressed={selected?.taskId === task.taskId}
                              onKeyDown={(event) => keyboard(event, task)}
                              onClick={() =>
                                setSelection({
                                  id: task.taskId,
                                  queue: queue.view,
                                  authority: queue.authority,
                                })
                              }
                            >
                              <strong>{task.customerDisplayName}</strong>
                              <span>{task.title}</span>
                              <time dateTime={task.dueAt}>
                                {due(task.dueAt, queue.data!.timezone)}
                              </time>
                              {task.policyNumber && <small>{task.policyNumber}</small>}
                            </button>
                          </li>
                        ))}
                    </ul>
                  </section>
                ))}
                {!items.length && <p>Bu kuyrukta gösterilecek takip bulunmuyor.</p>}
                {hasMore && !queue.failure && (
                  <Button variant="outline" disabled={!!queue.loading} onClick={queue.more}>
                    Daha fazla iş yükle
                  </Button>
                )}
              </CardContent>
            </Card>
            <Card className="today-overview" aria-label="Seçili görev özeti">
              <CardHeader>
                <CardTitle>
                  <span ref={overview} tabIndex={-1}>
                    {selected ? selected.customerDisplayName : 'Bir takip seçin'}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {selected ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => {
                        returnFocus.current = true;
                        setSelection(null);
                      }}
                    >
                      Görev listesine dön
                    </Button>
                    <h3>{selected.title}</h3>
                    <dl className="today-task-facts">
                      <div>
                        <dt>Vade zamanı</dt>
                        <dd>{due(selected.dueAt, queue.data.timezone)}</dd>
                      </div>
                      <div>
                        <dt>Yenileme durumu</dt>
                        <dd>{states[selected.renewalState] ?? selected.renewalState}</dd>
                      </div>
                      {selected.policyNumber && (
                        <div>
                          <dt>Poliçe numarası</dt>
                          <dd>{selected.policyNumber}</dd>
                        </div>
                      )}
                      {selected.policyEndDate && (
                        <div>
                          <dt>Poliçe bitişi</dt>
                          <dd>{due(selected.policyEndDate, queue.data.timezone, true)}</dd>
                        </div>
                      )}
                      {selected.customerPhone && (
                        <div>
                          <dt>Telefon</dt>
                          <dd>{selected.customerPhone}</dd>
                        </div>
                      )}
                      {selected.customerEmail && (
                        <div>
                          <dt>E-posta</dt>
                          <dd>{selected.customerEmail}</dd>
                        </div>
                      )}
                    </dl>
                    {selected.needsReassignment && (
                      <p>
                        Sorumlunun yeniden atanması gerekiyor. Mevcut atama otomatik değiştirilmez.
                      </p>
                    )}
                    <p>
                      Görüşme, iletişim kaydı, teklif, sonuçlandırma, görev tamamlama ve atama
                      klasik çalışma alanındadır. Bağlantı bu görevi otomatik seçmez; klasik
                      listeden yeniden seçmeniz gerekir.
                    </p>
                    <Button asChild>
                      <Link to="/today-work/legacy">Klasik iş akışını aç</Link>
                    </Button>
                  </>
                ) : (
                  <p>
                    Kuyruktan yüklü bir görev seçin. Tekil görev detay endpoint'i veya otomatik
                    hedef seçimi kullanılmaz.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
          <div className="today-statistics">
            <TaskStatisticsPanel key={queue.authority} refreshKey={queue.authority} />
          </div>
        </>
      )}
    </div>
  );
}
export default function TodayWorkPage({ owner }: { owner: boolean }) {
  return <Workspace key={owner ? 'owner' : 'member'} owner={owner} />;
}

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Link, useNavigate } from 'react-router';
import type { RenewalStateCode, TodayTaskDto } from '../../../shared/types';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { TaskStatisticsPanel } from '../../components/TaskStatisticsPanel';
import { useTaskQueue, type WorkQueue } from './use-task-queue';
import { RenewalInteractionsSection } from './RenewalInteractionsSection';
import type { InteractionRisk } from './interaction-model';
import { TaskOperationsSection, type TaskOperationRisk } from './TaskOperationsSection';
import { RenewalQuotesSection, type QuoteRisk } from './RenewalQuotesSection';
import { registerQuotePopGuard } from './quote-navigation';

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
  const navigate = useNavigate();
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [operationMessage, setOperationMessage] = useState(''),
    [operationUnresolved, setOperationUnresolved] = useState(false);
  const operationRisk = useRef<{ key: string; risk: TaskOperationRisk } | null>(null);
  const quoteRisk = useRef<{ key: string; risk: QuoteRisk } | null>(null);
  const [quoteBlocking, setQuoteBlocking] = useState(false);
  const leaveHeading = useRef<HTMLHeadingElement>(null),
    activeInteraction = useRef<string | null>(null),
    interactionRisk = useRef<{ key: string; risk: InteractionRisk } | null>(null);
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
  const interactionKey = selected
    ? `${queue.view}:${queue.authority}:${selected.taskId}:${selected.renewalId}`
    : null;
  activeInteraction.current = interactionKey;
  useEffect(() => {
    setLeave(null);
    interactionRisk.current = null;
    operationRisk.current = null;
    quoteRisk.current = null;
    setQuoteBlocking(false);
    setOperationUnresolved(false);
  }, [queue.authority, queue.view]);
  function guarded(action: () => void) {
    if (quoteRisk.current?.key === interactionKey && quoteRisk.current.risk.unresolved) {
      setOperationMessage(
        'Teklif işleminin belirsiz sonucu veya yazım sonrası okuması çözülmeden hedef/liste değiştirilemez. Özgün anahtar korunur; işlem iptal edilmiş değildir.',
      );
      return;
    }
    if (operationRisk.current?.key === interactionKey && operationRisk.current.risk.unresolved) {
      setOperationMessage(
        'Görev işleminin sonucu çözülmeden liste veya hedef değiştirilemez. Aynı isteği ya da yalnız okumayı yeniden deneyin; işlem iptal edilmiş değildir.',
      );
      return;
    }
    if (
      interactionKey &&
      ((interactionRisk.current?.key === interactionKey &&
        interactionRisk.current.risk !== 'clean') ||
        (operationRisk.current?.key === interactionKey && operationRisk.current.risk.dirty) ||
        (quoteRisk.current?.key === interactionKey && quoteRisk.current.risk.dirty))
    )
      setLeave(() => action);
    else action();
  }
  function classic(event: ReactMouseEvent<HTMLAnchorElement>) {
    if (
      interactionKey &&
      ((interactionRisk.current?.key === interactionKey &&
        interactionRisk.current.risk !== 'clean') ||
        (operationRisk.current?.key === interactionKey &&
          (operationRisk.current.risk.dirty || operationRisk.current.risk.unresolved)) ||
        (quoteRisk.current?.key === interactionKey &&
          (quoteRisk.current.risk.dirty || quoteRisk.current.risk.unresolved)))
    ) {
      event.preventDefault();
      guarded(() => void navigate('/today-work/legacy'));
    }
  }
  useEffect(() => {
    if (!interactionKey) return;
    const index = history.state?.idx as unknown;
    let restoring = false;
    const quoteAtRisk = () =>
      quoteRisk.current?.key === interactionKey &&
      (quoteRisk.current.risk.dirty || quoteRisk.current.risk.unresolved);
    const click = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (
        !quoteAtRisk() ||
        !(link instanceof HTMLAnchorElement) ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        link.hasAttribute('download') ||
        (link.target && link.target !== '_self') ||
        link.href === location.href
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (quoteRisk.current?.risk.unresolved) {
        setOperationMessage(
          'Teklif işleminin belirsiz sonucu çözülmeden başka sayfaya geçilemez. Özgün istek/anahtar bu ekranda korunur.',
        );
        return;
      }
      const url = new URL(link.href);
      setLeave(() => () => {
        if (url.origin === location.origin) void navigate(url.pathname + url.search + url.hash);
        else location.assign(url.href);
      });
    };
    const pop = (event: PopStateEvent) => {
      if (restoring) {
        restoring = false;
        event.stopImmediatePropagation();
        return;
      }
      const next = event.state?.idx as unknown;
      if (
        !quoteAtRisk() ||
        !Number.isSafeInteger(index) ||
        !Number.isSafeInteger(next) ||
        next === index
      )
        return;
      // The early AuthShell boundary invokes this before Router's native listener.
      // Restore its same-document index without storing the draft/key in history.
      event.stopImmediatePropagation();
      restoring = true;
      history.go((index as number) - (next as number));
      setOperationMessage(
        'Tarayıcı geri/ileri geçişi durduruldu. Önce teklif yazımını doğrulayın veya kaydedilmemiş teklif taslağını açıkça bırakın.',
      );
    };
    document.addEventListener('click', click, true);
    const removePopGuard = registerQuotePopGuard(pop);
    return () => {
      document.removeEventListener('click', click, true);
      removePopGuard();
    };
  }, [interactionKey, navigate]);
  useEffect(() => {
    if (leave) leaveHeading.current?.focus();
  }, [leave]);
  useEffect(() => {
    if (selected) overview.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      heading.current?.focus();
    }
  }, [selected]);
  function change(next: WorkQueue) {
    if (next !== queue.view) {
      guarded(() => {
        setSelection(null);
        queue.change(next);
      });
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
        description="Yetkili kuyruktan bir takip seçin; iletişim geçmişini okuyun ve görüşme kaydedin. İleri işlemler klasik çalışma alanındadır."
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
            guarded(() => {
              setSelection(null);
              queue.refresh();
            });
          }}
        >
          Listeyi yenile
        </Button>
        <Button variant="outline" asChild>
          <Link to="/today-work/legacy" onClick={classic}>
            Klasik çalışma alanı
          </Link>
        </Button>
      </div>
      {leave && (
        <section role="alert" className="interaction-leave">
          <h3 ref={leaveHeading} tabIndex={-1}>
            Hedefi değiştirmeden önce
          </h3>
          <p>
            Kaydedilmemiş taslak veya doğrulanmamış bir işlem var. Ayrılmak sunucuya ulaşmış isteği
            iptal etmez. Bu bölümün taslağı/anahtarı kaybolabilir; yeni kayıt göndermeden önce
            geçmişi yetkili okuyup kontrol edin.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setLeave(null);
              overview.current?.focus();
            }}
          >
            Bu ekranda kal
          </Button>
          <Button
            onClick={() => {
              const action = leave;
              if (quoteRisk.current?.key === interactionKey && quoteRisk.current.risk.unresolved) {
                setLeave(null);
                setOperationMessage('Önce teklif işleminin belirsiz sonucunu doğrulayın.');
                return;
              }
              if (
                operationRisk.current?.key === interactionKey &&
                operationRisk.current.risk.unresolved
              ) {
                setLeave(null);
                setOperationMessage('Önce görev işleminin belirsiz sonucunu doğrulayın.');
                return;
              }
              setLeave(null);
              action();
            }}
          >
            Ayrılmayı onayla
          </Button>
        </section>
      )}
      {operationMessage && <p role="status">{operationMessage}</p>}
      {queue.loading && <p role="status">Görevler yükleniyor…</p>}
      {queue.failure && (
        <div role="alert">
          <p>{queue.failure.message}</p>
          <Button
            variant="outline"
            disabled={!!queue.loading}
            onClick={() => guarded(() => queue.retry())}
          >
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
                                guarded(() =>
                                  setSelection({
                                    id: task.taskId,
                                    queue: queue.view,
                                    authority: queue.authority,
                                  }),
                                )
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
                  <Button
                    variant="outline"
                    disabled={!!queue.loading}
                    onClick={() => {
                      if (
                        operationRisk.current?.key === interactionKey &&
                        operationRisk.current.risk.unresolved
                      ) {
                        setOperationMessage('Önce belirsiz görev işlemini doğrulayın.');
                        return;
                      }
                      if (
                        quoteRisk.current?.key === interactionKey &&
                        quoteRisk.current.risk.unresolved
                      ) {
                        setOperationMessage('Önce belirsiz teklif işlemini doğrulayın.');
                        return;
                      }
                      queue.more();
                    }}
                  >
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
                        guarded(() => {
                          returnFocus.current = true;
                          setSelection(null);
                        });
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
                    <fieldset
                      disabled={operationUnresolved || quoteBlocking}
                      className="task-interaction-boundary"
                    >
                      <legend className="sr-only">İletişim bölümü</legend>
                      <RenewalInteractionsSection
                        key={interactionKey}
                        renewalId={selected.renewalId}
                        onRiskChange={(risk) => {
                          if (activeInteraction.current === interactionKey)
                            interactionRisk.current = { key: interactionKey!, risk };
                        }}
                      />
                    </fieldset>
                    <fieldset disabled={quoteBlocking} className="task-interaction-boundary">
                      <legend className="sr-only">Görev işlemleri alanı</legend>
                      <TaskOperationsSection
                        key={'operations:' + interactionKey}
                        task={selected}
                        read={(signal) => queue.readOperation(selected.taskId, signal)}
                        canOperate={() => {
                          if (activeInteraction.current !== interactionKey) return false;
                          if (
                            quoteRisk.current?.key === interactionKey &&
                            (quoteRisk.current.risk.dirty || quoteRisk.current.risk.unresolved)
                          ) {
                            setOperationMessage(
                              'Önce teklif taslağını açıkça kapatın veya teklif yazımını doğrulayın.',
                            );
                            return false;
                          }
                          if (
                            interactionRisk.current?.key === interactionKey &&
                            interactionRisk.current.risk !== 'clean'
                          ) {
                            setOperationMessage(
                              'İletişim taslağını açıkça kapatın veya iletişim yazımını doğrulayın. Görev işlemi iletişim taslağını/anahtarını silmez.',
                            );
                            return false;
                          }
                          return true;
                        }}
                        onRisk={(risk) => {
                          if (activeInteraction.current === interactionKey) {
                            operationRisk.current = { key: interactionKey!, risk };
                            setOperationUnresolved(risk.unresolved);
                          }
                        }}
                        onApplied={(message) => setOperationMessage(message)}
                      />
                    </fieldset>
                    <RenewalQuotesSection
                      key={'quotes:' + interactionKey}
                      renewalId={selected.renewalId}
                      renewalVersion={selected.renewalVersion}
                      renewalOpen={!['WON', 'LOST', 'VOIDED'].includes(selected.renewalState)}
                      compareRenewal={async (signal) => {
                        const fresh = await queue.readOperation(selected.taskId, signal);
                        return fresh.current?.renewalId === selected.renewalId
                          ? fresh.current.renewalVersion
                          : null;
                      }}
                      canOperate={() => {
                        if (activeInteraction.current !== interactionKey) return false;
                        if (
                          (interactionRisk.current?.key === interactionKey &&
                            interactionRisk.current.risk !== 'clean') ||
                          (operationRisk.current?.key === interactionKey &&
                            (operationRisk.current.risk.dirty ||
                              operationRisk.current.risk.unresolved))
                        ) {
                          setOperationMessage(
                            'İletişim/görev taslağını açıkça kapatın veya önceki yazımı doğrulayın. Teklif işlemi mevcut taslağı/anahtarı silmez.',
                          );
                          return false;
                        }
                        return true;
                      }}
                      onRisk={(risk) => {
                        if (activeInteraction.current === interactionKey) {
                          quoteRisk.current = { key: interactionKey!, risk };
                          setQuoteBlocking(risk.dirty || risk.unresolved);
                        }
                      }}
                    />
                    <p>
                      Teklif gönderim/kabul/ret, WhatsApp önizleme/açma ve yenileme sonuçlandırma
                      klasik çalışma alanındadır. Bağlantı bu görevi otomatik seçmez; klasik
                      listeden yeniden seçmeniz gerekir.
                    </p>
                    <Button asChild>
                      <Link to="/today-work/legacy" onClick={classic}>
                        Klasik iş akışını aç
                      </Link>
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

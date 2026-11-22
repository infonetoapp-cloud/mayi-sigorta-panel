import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { CircleAlert, RefreshCw } from 'lucide-react';
import type { RenewalStateCode, TodayTaskDto } from '../../../shared/types';
import type { SalesTaskDto } from '../../../shared/sales';
import { PageHeader } from '../../components/layout/PageContainer';
import { NavigationDecision } from '../../components/layout/NavigationDecision';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { TaskStatisticsPanel } from '../../components/TaskStatisticsPanel';
import { useTaskQueue, type WorkQueue } from './use-task-queue';
import { RenewalInteractionsSection } from './RenewalInteractionsSection';
import type { InteractionRisk } from './interaction-model';
import { TaskOperationsSection, type TaskOperationRisk } from './TaskOperationsSection';
import { RenewalQuotesSection, type QuoteRisk } from './RenewalQuotesSection';
import { registerQuotePopGuard } from './quote-navigation';
import { RenewalOutcomesSection } from './RenewalOutcomesSection';
import { OperationSelector, OperationPanel } from '../../components/workspace/OperationWorkspace';
import { RecordDetails } from '../../components/workspace/RecordDetails';
import { WorkQueueTable, workQueueBuckets } from './WorkQueueTable';
import {
  useWorkNavigation,
  workUrl,
  workSectionLabels,
  type WorkBookmark,
} from './work-navigation';

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
  const route = useLocation();
  const navigation = useWorkNavigation();
  const [bookmark] = useState<WorkBookmark | undefined>(() => {
    const key: unknown = route.state?.workContext;
    const saved = navigation?.entries.get(typeof key === 'string' ? key : route.key);
    if (saved) return saved;
    const params = new URLSearchParams(route.search);
    const taskId = params.get('task');
    if (!taskId) return undefined;
    const mode = params.get('queue');
    const matching = [...(navigation?.entries.values() ?? [])]
      .reverse()
      .find((entry) => entry.taskId === taskId && entry.queue === mode);
    if (matching) return matching;
    const section = Object.entries(workSectionLabels).find(
      ([id]) => id === params.get('work'),
    )?.[1];
    return {
      taskId,
      queue: mode === 'UNASSIGNED' || mode === 'REASSIGNMENT' ? mode : 'WORK',
      pageUrls: [],
      pageScroll: 0,
      queueScroll: 0,
      sections: section ? { [section]: true } : {},
    };
  });
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [queueSearch, setQueueSearch] = useState(bookmark?.queueSearch ?? '');
  const [queueBucket, setQueueBucket] = useState(bookmark?.queueBucket ?? 'ALL');
  const [focusedSection, setFocusedSection] = useState<{
    key: string | null;
    title: string | null;
  } | null>(null);
  const notice = useRef<HTMLParagraphElement>(null);
  function stay() {
    document.querySelector<HTMLDialogElement>('.navigation-decision')?.close?.();
    setLeave(null);
    overview.current?.focus();
  }
  const [outcomeLink, setOutcomeLink] = useState<{ renewalId: string; message: string } | null>(
    null,
  );
  const [operationMessage, setOperationMessage] = useState(''),
    [operationUnresolved, setOperationUnresolved] = useState(false);
  const operationRisk = useRef<{ key: string; risk: TaskOperationRisk } | null>(null);
  const quoteRisk = useRef<{ key: string; risk: QuoteRisk } | null>(null);
  const terminalRisk = useRef<{ key: string; risk: TaskOperationRisk } | null>(null);
  const [terminalBlocking, setTerminalBlocking] = useState(false);
  const [quoteBlocking, setQuoteBlocking] = useState(false);
  const [communicationPinned, setCommunicationPinned] = useState(false);
  const [taskPinned, setTaskPinned] = useState(false);
  const leaveHeading = useRef<HTMLHeadingElement>(null),
    activeInteraction = useRef<string | null>(null),
    interactionRisk = useRef<{ key: string; risk: InteractionRisk } | null>(null);
  const queue = useTaskQueue(owner, bookmark),
    [selection, setSelection] = useState<{
      id: string;
      queue: WorkQueue;
      authority: number;
    } | null>(null);
  const overview = useRef<HTMLHeadingElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    customerLink = useRef<HTMLAnchorElement>(null),
    policyLink = useRef<HTMLAnchorElement>(null),
    returnFocus = useRef(false),
    buttons = useRef(new Map<string, HTMLElement>());
  const items = queue.data
    ? queue.view === 'UNASSIGNED'
      ? queue.data.unassignedItems
      : queue.data.items
    : [];
  const selected =
    selection?.queue === queue.view && selection.authority === queue.authority
      ? items.find(
          (task): task is TodayTaskDto => task.kind !== 'GENERAL' && task.taskId === selection.id,
        )
      : undefined;
  useEffect(() => {
    if (queue.restoredSelection) setSelection({ ...queue.restoredSelection, queue: queue.view });
  }, [queue.restoredSelection]);
  function remember(returnFocus: NonNullable<WorkBookmark['returnFocus']>) {
    if (!selected || !navigation) return;
    const sections: Record<string, boolean> = {};
    document.querySelectorAll('.workspace-section').forEach((element) => {
      const title = element.getAttribute('data-title');
      if (title) sections[title] = element.getAttribute('data-open') === 'true';
    });
    navigation.entries.set(route.key, {
      taskId: selected.taskId,
      queue: queue.view,
      pageUrls: queue.pageUrls(),
      pageScroll: scrollY,
      returnFocus,
      queueScroll:
        document.querySelector('.today-queue > [data-slot="card-content"]')?.scrollTop ?? 0,
      operationScroll: document.querySelector('.crm-operation-region')?.scrollTop ?? 0,
      sections,
      queueSearch,
      queueBucket,
    });
    if (navigation.entries.size > 10)
      navigation.entries.delete(navigation.entries.keys().next().value!);
  }
  function rememberGeneral(task: SalesTaskDto) {
    if (!navigation) return;
    navigation.entries.set(route.key, {
      taskId: task.taskId,
      queue: queue.view,
      pageUrls: queue.pageUrls(),
      pageScroll: scrollY,
      queueScroll:
        document.querySelector('.today-queue > [data-slot="card-content"]')?.scrollTop ?? 0,
      sections: {},
      queueSearch,
      queueBucket,
    });
    if (navigation.entries.size > 10)
      navigation.entries.delete(navigation.entries.keys().next().value!);
  }

  function sectionHint(id: keyof typeof workSectionLabels, open: boolean) {
    setFocusedSection({ key: interactionKey, title: open ? workSectionLabels[id] : null });
    const params = new URLSearchParams(route.search);
    if (open) params.set('work', id);
    else if (params.get('work') === id) params.delete('work');
    void navigate(
      { pathname: '/today-work', search: '?' + params },
      { replace: true, state: route.state },
    );
  }
  const bookmarkRestored = useRef(false);
  useEffect(() => {
    if (
      bookmarkRestored.current ||
      !bookmark ||
      queue.restoredSelection?.id !== bookmark.taskId ||
      queue.restoredSelection.authority !== queue.authority ||
      (selected?.taskId !== bookmark.taskId &&
        !items.some((item) => item.kind === 'GENERAL' && item.taskId === bookmark.taskId))
    )
      return;
    const frame = requestAnimationFrame(() => {
      bookmarkRestored.current = true;
      const link =
        bookmark.returnFocus === 'customer'
          ? customerLink.current
          : bookmark.returnFocus === 'policy'
            ? policyLink.current
            : null;
      if (bookmark.returnFocus) (link ?? overview.current)?.focus({ preventScroll: true });
      if (
        !bookmark.returnFocus &&
        !bookmark.pageScroll &&
        !bookmark.queueScroll &&
        !bookmark.operationScroll
      )
        return;
      const list = document.querySelector('.today-queue > [data-slot="card-content"]');
      if (list) list.scrollTop = bookmark.queueScroll;
      const area = document.querySelector('.crm-operation-region');
      if (area) area.scrollTop = bookmark.operationScroll ?? 0;
      scrollTo(0, bookmark.pageScroll);
    });
    return () => cancelAnimationFrame(frame);
  }, [selected?.taskId, bookmark, items, queue.restoredSelection, queue.authority]);
  const interactionKey = selected
    ? `${queue.view}:${queue.authority}:${selected.taskId}:${selected.renewalId}`
    : null;
  activeInteraction.current = interactionKey;
  function sectionActive(title: string) {
    if (focusedSection?.key === interactionKey) return focusedSection.title === title;
    const restored =
      selected?.taskId === bookmark?.taskId
        ? Object.values(workSectionLabels)
            .filter((label) => bookmark?.sections[label])
            .at(-1)
        : undefined;
    return title === (restored ?? 'Teklifler');
  }
  useEffect(() => {
    if (interactionKey) setOperationMessage('');
  }, [interactionKey]);
  useEffect(() => {
    setLeave(null);
    interactionRisk.current = null;
    operationRisk.current = null;
    quoteRisk.current = null;
    terminalRisk.current = null;
    setTerminalBlocking(false);
    setQuoteBlocking(false);
    setOperationUnresolved(false);
    setCommunicationPinned(false);
    setTaskPinned(false);
  }, [queue.authority, queue.view]);
  function guarded(action: () => void) {
    if (
      (terminalRisk.current?.key === interactionKey && terminalRisk.current.risk.unresolved) ||
      (interactionRisk.current?.key === interactionKey &&
        ['uncertain', 'saved-unread'].includes(interactionRisk.current.risk))
    ) {
      setOperationMessage(
        'Sonuçlandırma/iletişim işleminin sonucu doğrulanmadan hedef veya liste değiştirilemez. Özgün istek korunur.',
      );
      return;
    }
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
        (quoteRisk.current?.key === interactionKey && quoteRisk.current.risk.dirty) ||
        (terminalRisk.current?.key === interactionKey && terminalRisk.current.risk.dirty))
    )
      setLeave(() => action);
    else action();
  }
  useEffect(() => {
    if (!interactionKey) return;
    const index = history.state?.idx as unknown;
    let restoring = false;
    let confirmedPop = false;
    const quoteAtRisk = () =>
      (quoteRisk.current?.key === interactionKey &&
        (quoteRisk.current.risk.dirty || quoteRisk.current.risk.unresolved)) ||
      (terminalRisk.current?.key === interactionKey &&
        (terminalRisk.current.risk.dirty || terminalRisk.current.risk.unresolved)) ||
      (operationRisk.current?.key === interactionKey &&
        (operationRisk.current.risk.dirty || operationRisk.current.risk.unresolved)) ||
      (interactionRisk.current?.key === interactionKey && interactionRisk.current.risk !== 'clean');
    const unresolved = () =>
      (quoteRisk.current?.key === interactionKey && quoteRisk.current.risk.unresolved) ||
      (terminalRisk.current?.key === interactionKey && terminalRisk.current.risk.unresolved) ||
      (operationRisk.current?.key === interactionKey && operationRisk.current.risk.unresolved) ||
      (interactionRisk.current?.key === interactionKey &&
        ['uncertain', 'saved-unread'].includes(interactionRisk.current.risk));
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
      document.dispatchEvent(new Event('mayi-navigation-attention'));
      if (unresolved()) {
        setOperationMessage(
          'Teklif/görev/iletişim/sonuçlandırma işleminin belirsiz sonucu çözülmeden başka sayfaya geçilemez. Özgün istek/anahtar bu ekranda korunur.',
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
      if (confirmedPop) {
        confirmedPop = false;
        return;
      }
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
      document.dispatchEvent(new Event('mayi-navigation-attention'));
      if (!unresolved()) {
        setLeave(() => () => {
          confirmedPop = true;
          history.go((next as number) - (index as number));
        });
      }
      setOperationMessage(
        'Tarayıcı geri/ileri geçişi durduruldu. Önce teklif/görev/iletişim/sonuçlandırma yazımını doğrulayın veya kaydedilmemiş taslağı açıkça bırakın.',
      );
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (quoteAtRisk()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    addEventListener('beforeunload', unload);
    document.addEventListener('click', click, true);
    const removePopGuard = registerQuotePopGuard(pop);
    return () => {
      document.removeEventListener('click', click, true);
      removeEventListener('beforeunload', unload);
      removePopGuard();
    };
  }, [interactionKey, navigate]);
  useEffect(() => {
    if (leave) leaveHeading.current?.focus();
  }, [leave]);
  useEffect(() => {
    if (operationMessage) notice.current?.focus();
  }, [operationMessage]);
  useEffect(() => {
    if (selected) {
      if (bookmarkRestored.current || selected.taskId !== bookmark?.taskId || !bookmark.returnFocus)
        overview.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      heading.current?.focus();
    }
  }, [selected, bookmark]);
  function change(next: WorkQueue) {
    const menu = document.querySelector<HTMLDetailsElement>('.employee-team-tools');
    if (menu) menu.open = false;
    if (next !== queue.view) {
      guarded(() => {
        setSelection(null);
        queue.change(next);
        void navigate('/today-work?' + new URLSearchParams({ queue: next }), { replace: true });
      });
    }
  }
  function keyboard(event: KeyboardEvent<HTMLElement>, task: (typeof items)[number]) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const renderedItems = workQueueBuckets.flatMap((bucket) =>
      visibleItems.filter((row) => row.bucket === bucket),
    );
    const index = renderedItems.findIndex((row) => row.taskId === task.taskId);
    const next =
      event.key === 'ArrowDown'
        ? Math.min(index + 1, renderedItems.length - 1)
        : event.key === 'ArrowUp'
          ? Math.max(index - 1, 0)
          : event.key === 'Home'
            ? 0
            : renderedItems.length - 1;
    const row = renderedItems[next];
    if (!row) return;
    event.preventDefault();
    buttons.current.get(row.taskId)?.focus();
  }
  const hasMore = queue.view === 'UNASSIGNED' ? queue.data?.unassignedHasMore : queue.data?.hasMore;
  const visibleItems = items.filter(
    (task) =>
      (queueBucket === 'ALL' || task.bucket === queueBucket) &&
      `${task.customerDisplayName} ${task.policyNumber ?? ''} ${task.title} ${task.kind === 'GENERAL' ? (task.branchName ?? '') : (task.policyBranchName ?? '')}`
        .toLocaleLowerCase('tr-TR')
        .includes(queueSearch.trim().toLocaleLowerCase('tr-TR')),
  );
  const operationIds: Array<keyof typeof workSectionLabels> = [
    'communication',
    'quotes',
    'task',
    'outcomes',
  ];
  const activeOperation =
    operationIds.find((id) => sectionActive(workSectionLabels[id])) ?? 'communication';
  const operationRisks = {
    communication: communicationPinned,
    task: taskPinned,
    quotes: quoteBlocking,
    outcomes: terminalBlocking,
  };
  return (
    <div className="today-modern crm-workspace employee-workspace">
      <PageHeader
        title="Bugünkü İşler"
        description={
          queue.data
            ? due(queue.data.todayLocalDate + 'T12:00:00Z', queue.data.timezone, true)
            : 'Günlük takip ve yenileme çalışma alanı'
        }
      />
      {queue.data && !selected && (
        <div className="employee-day-summary" aria-label="Yüklenen takiplerin özeti">
          <div className="employee-day-card" data-tone="late">
            <CircleAlert size={32} aria-hidden="true" />
            <div>
              <strong>Geciken takipler</strong>
              <b>{items.filter((item) => item.bucket === 'OVERDUE').length}</b>
              <small>Yüklenen kayıtlarda</small>
            </div>
          </div>
          <div className="employee-day-card" data-tone="planned">
            <RefreshCw size={32} aria-hidden="true" />
            <div>
              <strong>Bugün ve yaklaşan</strong>
              <b>{items.filter((item) => item.bucket !== 'OVERDUE').length}</b>
              <small>Planlanmış takipler · yüklenen kayıtlarda</small>
            </div>
          </div>
        </div>
      )}
      <div className="today-toolbar">
        {queue.view !== 'WORK' && (
          <Button variant="outline" onClick={() => change('WORK')}>
            Takip listesine dön
          </Button>
        )}
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
      </div>
      {queue.unavailable && <p role="alert">{queue.unavailable}</p>}
      {leave && (
        <NavigationDecision onStay={stay}>
          <h3 id="navigation-decision-title" ref={leaveHeading} tabIndex={-1}>
            Hedefi değiştirmeden önce
          </h3>
          <p>
            Kaydedilmemiş taslak veya doğrulanmamış bir işlem var. Ayrılmak sunucuya ulaşmış isteği
            iptal etmez. Bu bölümün taslağı/anahtarı kaybolabilir; yeni kayıt göndermeden önce
            geçmişi yetkili okuyup kontrol edin.
          </p>
          <Button variant="outline" onClick={stay}>
            Bu ekranda kal
          </Button>
          <Button
            onClick={() => {
              const action = leave;
              if (
                (terminalRisk.current?.key === interactionKey &&
                  terminalRisk.current.risk.unresolved) ||
                (interactionRisk.current?.key === interactionKey &&
                  ['uncertain', 'saved-unread'].includes(interactionRisk.current.risk))
              ) {
                setLeave(null);
                setOperationMessage(
                  'Önce sonuçlandırma/iletişim işleminin belirsiz sonucunu doğrulayın.',
                );
                return;
              }
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
        </NavigationDecision>
      )}
      {operationMessage && (
        <p ref={notice} tabIndex={-1} role="status">
          {operationMessage}
          {outcomeLink?.message === operationMessage && (
            <>
              {' '}
              <Link to={`/renewals/${encodeURIComponent(outcomeLink.renewalId)}`}>
                Yenileme detayını aç
              </Link>
            </>
          )}
        </p>
      )}
      {queue.loading && (
        <span role="status" className="crm-read-progress" aria-label="Görevler yükleniyor">
          •••
        </span>
      )}
      {queue.failure && (
        <div>
          <p role="alert">{queue.failure.message}</p>
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
                    {owner ? 'Açık işler' : 'Kendi işlerim'}
                  </span>
                </CardTitle>
                <div className="crm-queue-filters">
                  <label htmlFor="work-queue-search">Yüklü takiplerde ara</label>
                  <input
                    id="work-queue-search"
                    type="search"
                    value={queueSearch}
                    onChange={(event) => setQueueSearch(event.target.value)}
                    placeholder="Müşteri, branş veya poliçe"
                  />
                  <label className="sr-only" htmlFor="work-queue-filter">
                    Takip zamanı
                  </label>
                  <select
                    id="work-queue-filter"
                    value={queueBucket}
                    onChange={(event) => setQueueBucket(event.target.value)}
                  >
                    <option value="ALL">Tüm zamanlar</option>
                    <option value="OVERDUE">Geciken</option>
                    <option value="TODAY">Bugün</option>
                    <option value="UPCOMING">Yaklaşan</option>
                  </select>
                  <small>
                    {visibleItems.length} yüklü takip · {queue.data.todayLocalDate}
                  </small>
                </div>
              </CardHeader>
              <CardContent>
                <WorkQueueTable
                  onGeneralNavigate={rememberGeneral}
                  items={visibleItems}
                  selectedId={selected?.taskId}
                  timezone={queue.data.timezone}
                  onKeyDown={keyboard}
                  register={(id, node) => {
                    if (node) buttons.current.set(id, node);
                    else buttons.current.delete(id);
                  }}
                  onSelect={(task) =>
                    guarded(() => {
                      setSelection({
                        id: task.taskId,
                        queue: queue.view,
                        authority: queue.authority,
                      });
                      void navigate(workUrl(task.taskId, queue.view), { replace: true });
                    })
                  }
                />
                {!items.length && <p>Bu kuyrukta gösterilecek takip bulunmuyor.</p>}
                {!!items.length && !visibleItems.length && (
                  <p>
                    Yüklü takiplerde eşleşme yok.
                    {hasMore && queueSearch.trim()
                      ? ' Sonraki sayfada arayabilirsiniz.'
                      : ' Aramayı veya zaman filtresini değiştirin.'}
                  </p>
                )}
                {hasMore && !queue.failure && (
                  <Button
                    variant="outline"
                    disabled={!!queue.loading}
                    onClick={() => {
                      if (
                        terminalRisk.current?.key === interactionKey &&
                        (terminalRisk.current.risk.dirty || terminalRisk.current.risk.unresolved)
                      ) {
                        setOperationMessage(
                          'Önce sonuçlandırma taslağını kapatın veya yazımını doğrulayın.',
                        );
                        return;
                      }
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
                    {queueSearch.trim() && !visibleItems.length
                      ? 'Sonraki yetkili işlerde ara'
                      : 'Daha fazla iş yükle'}
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
                      variant="ghost"
                      onClick={() => {
                        guarded(() => {
                          returnFocus.current = true;
                          setSelection(null);
                        });
                      }}
                    >
                      Görev listesine dön
                    </Button>
                    <section className="today-summary" aria-label="Özet" tabIndex={-1}>
                      <div className="today-summary-heading">
                        <h3>{selected.title}</h3>
                        <span className="today-status" data-kind={selected.bucket}>
                          {selected.bucket === 'OVERDUE'
                            ? 'Geciken'
                            : selected.bucket === 'TODAY'
                              ? 'Bugün'
                              : 'Yaklaşan'}
                        </span>
                      </div>
                      <nav className="today-context-links" aria-label="Seçili kayıtlar">
                        <Button asChild variant="ghost" size="sm">
                          <Link
                            to={`/customers/${encodeURIComponent(selected.customerId)}`}
                            ref={customerLink}
                            onClick={() => remember('customer')}
                            state={{ workReturn: route.key }}
                          >
                            Müşteri profilini aç
                          </Link>
                        </Button>
                        {selected.policyId && (
                          <Button asChild variant="ghost" size="sm">
                            <Link
                              to={`/policies/${encodeURIComponent(selected.policyId)}`}
                              ref={policyLink}
                              onClick={() => remember('policy')}
                              state={{ workReturn: route.key }}
                            >
                              Poliçeyi aç
                            </Link>
                          </Button>
                        )}
                      </nav>
                      <dl className="today-task-facts">
                        {selected.policyBranchName && (
                          <div>
                            <dt>Branş</dt>
                            <dd>
                              <span className="work-branch">{selected.policyBranchName}</span>
                            </dd>
                          </div>
                        )}
                        {selected.policyInsurerName && (
                          <div>
                            <dt>Mevcut şirket</dt>
                            <dd>{selected.policyInsurerName}</dd>
                          </div>
                        )}

                        <div>
                          <dt>Sonraki takip</dt>
                          <dd>{due(selected.dueAt, queue.data.timezone)}</dd>
                        </div>
                        <div>
                          <dt>İşin durumu</dt>
                          <dd>
                            <span className="today-stage">
                              {states[selected.renewalState] ?? selected.renewalState}
                            </span>
                          </dd>
                        </div>
                        {selected.policyNumber && (
                          <div>
                            <dt>Poliçe numarası</dt>
                            <dd>{selected.policyNumber}</dd>
                          </div>
                        )}
                        {selected.policyEndDate && (
                          <div>
                            <dt>Şirket müşteri no</dt>
                            <dd>{selected.policyInsurerCustomerNumber || 'Kaydedilmedi'}</dd>
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
                      <RecordDetails title="İş aşaması ve faaliyet kayıtları">
                        <p className="today-state-help">
                          İş aşaması, görüşme ve teklif kayıtlarından ayrıdır. Gerçek temas ve
                          gönderildi beyanları aşağıdaki yetkili geçmişte gösterilir; bu kayıtlar
                          aşamayı otomatik değiştirmez.
                        </p>
                      </RecordDetails>
                      {selected.needsReassignment && (
                        <p>
                          Sorumlunun yeniden atanması gerekiyor. Mevcut atama otomatik
                          değiştirilmez.
                        </p>
                      )}
                    </section>
                    <OperationSelector
                      active={activeOperation}
                      onChange={(id) => sectionHint(id as keyof typeof workSectionLabels, true)}
                      items={operationIds.map((id) => ({
                        id,
                        label: workSectionLabels[id],
                        risk: operationRisks[id],
                        unresolved:
                          id === 'communication'
                            ? ['uncertain', 'saved-unread'].includes(
                                interactionRisk.current?.risk ?? '',
                              )
                            : id === 'task'
                              ? operationUnresolved
                              : id === 'quotes'
                                ? quoteRisk.current?.risk.unresolved
                                : terminalRisk.current?.risk.unresolved,
                      }))}
                    />
                    <div className="crm-operation-region">
                      <OperationPanel
                        key={'communication-panel:' + interactionKey}
                        id="communication"
                        title="İletişim"
                        active={sectionActive('İletişim')}
                      >
                        <fieldset
                          disabled={operationUnresolved || quoteBlocking || terminalBlocking}
                          className="task-interaction-boundary"
                        >
                          <legend className="sr-only">İletişim bölümü</legend>
                          <RenewalInteractionsSection
                            key={interactionKey}
                            renewalId={selected.renewalId}
                            onRiskChange={(risk) => {
                              if (activeInteraction.current === interactionKey) {
                                interactionRisk.current = { key: interactionKey!, risk };
                                setCommunicationPinned(risk !== 'clean');
                              }
                            }}
                          />
                        </fieldset>
                      </OperationPanel>
                      <OperationPanel
                        key={'task-panel:' + interactionKey}
                        id="task"
                        title="Görev işlemleri"
                        active={sectionActive('Görev işlemleri')}
                      >
                        <fieldset
                          disabled={quoteBlocking || terminalBlocking}
                          className="task-interaction-boundary"
                        >
                          <legend className="sr-only">Görev işlemleri alanı</legend>
                          <TaskOperationsSection
                            key={'operations:' + interactionKey}
                            task={selected}
                            read={(signal) => queue.readOperation(selected.taskId, signal)}
                            canOperate={() => {
                              if (activeInteraction.current !== interactionKey) return false;
                              if (
                                terminalRisk.current?.key === interactionKey &&
                                (terminalRisk.current.risk.dirty ||
                                  terminalRisk.current.risk.unresolved)
                              )
                                return false;
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
                                setTaskPinned(risk.dirty || risk.unresolved);
                              }
                            }}
                            onApplied={(message) => setOperationMessage(message)}
                          />
                        </fieldset>
                      </OperationPanel>
                      <OperationPanel
                        key={'quote-panel:' + interactionKey}
                        id="quotes"
                        title="Teklifler"
                        active={sectionActive('Teklifler')}
                      >
                        <fieldset disabled={terminalBlocking} className="task-interaction-boundary">
                          <legend className="sr-only">Teklif işlemleri alanı</legend>
                          <RenewalQuotesSection
                            key={'quotes:' + interactionKey}
                            active={activeOperation === 'quotes'}
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
                                terminalRisk.current?.key === interactionKey &&
                                (terminalRisk.current.risk.dirty ||
                                  terminalRisk.current.risk.unresolved)
                              )
                                return false;
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
                        </fieldset>
                      </OperationPanel>
                      <OperationPanel
                        key={'outcome-panel:' + interactionKey}
                        id="outcomes"
                        title="Yenileme sonucu"
                        active={sectionActive('Yenileme sonucu')}
                      >
                        <RenewalOutcomesSection
                          cycleEnabled
                          key={'outcomes:' + interactionKey}
                          task={selected}
                          read={(signal) => queue.readOperation(selected.taskId, signal)}
                          canOperate={() => {
                            if (activeInteraction.current !== interactionKey) return false;
                            if (
                              (interactionRisk.current?.key === interactionKey &&
                                interactionRisk.current.risk !== 'clean') ||
                              (operationRisk.current?.key === interactionKey &&
                                (operationRisk.current.risk.dirty ||
                                  operationRisk.current.risk.unresolved)) ||
                              (quoteRisk.current?.key === interactionKey &&
                                (quoteRisk.current.risk.dirty || quoteRisk.current.risk.unresolved))
                            ) {
                              setOperationMessage(
                                'Önce iletişim/görev/teklif taslağını açıkça kapatın veya önceki yazımı doğrulayın. Sonuçlandırma mevcut taslağı/anahtarı silmez.',
                              );
                              return false;
                            }
                            return true;
                          }}
                          onRisk={(risk) => {
                            if (activeInteraction.current === interactionKey) {
                              terminalRisk.current = { key: interactionKey!, risk };
                              setTerminalBlocking(risk.dirty || risk.unresolved);
                            }
                          }}
                          onApplied={(message) => {
                            if (activeInteraction.current !== interactionKey) return;
                            setOperationMessage(message);
                            setOutcomeLink({ message, renewalId: selected.renewalId });
                            setSelection(null);
                            queue.refresh();
                          }}
                        />
                      </OperationPanel>
                    </div>
                  </>
                ) : (
                  <p>İşleme başlamak için kuyruktan bir takip seçin.</p>
                )}
              </CardContent>
            </Card>
          </div>
          <div className="today-statistics">
            <RecordDetails title="İş yükü özeti" lazy>
              <TaskStatisticsPanel key={queue.authority} refreshKey={queue.authority} embedded />
            </RecordDetails>
          </div>
        </>
      )}
    </div>
  );
}
export default function TodayWorkPage({ owner }: { owner: boolean }) {
  return <Workspace key={owner ? 'owner' : 'member'} owner={owner} />;
}

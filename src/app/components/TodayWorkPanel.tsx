import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApiResponse,
  CustomerAssignmentOptionDto,
  TodayTaskDto,
  TodayTasksResponseData,
} from '../../shared/types';
import { RenewalWorkspacePanel } from './RenewalWorkspacePanel';
import { TaskStatisticsPanel } from './TaskStatisticsPanel';

interface TodayWorkPanelProps {
  readonly getCsrfToken: () => Promise<string>;
  readonly invalidateCsrfToken: () => void;
}

interface CompletionAttempt {
  readonly renewalId: string;
  readonly taskId: string;
  readonly url: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

interface AssignmentAttempt {
  readonly taskId: string;
  readonly url: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

type TaskQueue = 'WORK' | 'UNASSIGNED';

interface FailedPage {
  readonly queue: TaskQueue;
  readonly cursor: string;
}

interface TaskMutationMessage {
  readonly taskId: string;
  readonly error: string | null;
  readonly success: string | null;
}

class TaskListRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Task list request failed (${status}).`);
    this.status = status;
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof TaskListRequestError) {
    if (error.status === 403 || error.status === 404) return 'Bu görev listesine erişilemiyor.';
    if (error.status === 409) return 'Liste güncellendi. Yenileyip tekrar deneyin.';
  }
  return 'Görev listesi yüklenemedi. Bağlantınızı denetleyip yeniden deneyin.';
}

function formatDueAt(value: string, timezone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Tarih bulunamadı';
  try {
    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return 'Tarih bulunamadı';
  }
}

interface LocalDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function localPartsAt(date: Date, timezone: string): LocalDateTimeParts | null {
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((value) => value.type === type)?.value);
    const result = {
      year: part('year'),
      month: part('month'),
      day: part('day'),
      hour: part('hour'),
      minute: part('minute'),
    };
    return Object.values(result).every(Number.isInteger) ? result : null;
  } catch {
    return null;
  }
}

function defaultReplacementDueValue(value: string, timezone: string): string {
  const local = localPartsAt(new Date(value), timezone);
  if (!local) return '';
  const tomorrow = new Date(
    Date.UTC(local.year, local.month - 1, local.day + 1, local.hour, local.minute),
  );
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${tomorrow.getUTCFullYear()}-${pad(tomorrow.getUTCMonth() + 1)}-${pad(tomorrow.getUTCDate())}T${pad(tomorrow.getUTCHours())}:${pad(tomorrow.getUTCMinutes())}`;
}

function localDateTimeToUtc(value: string, timezone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const target = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
  };
  if (
    target.month < 1 ||
    target.month > 12 ||
    target.day < 1 ||
    target.day > 31 ||
    target.hour < 0 ||
    target.hour > 23 ||
    target.minute < 0 ||
    target.minute > 59
  ) {
    return null;
  }
  const localEpoch = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
  );
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 3) {
    const sample = new Date(localEpoch + hours * 60 * 60 * 1000);
    const local = localPartsAt(sample, timezone);
    if (!local) return null;
    const sampleMinute = Math.floor(sample.getTime() / 60_000) * 60_000;
    offsets.add(
      Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sampleMinute,
    );
  }

  const candidates = [...offsets]
    .map((offset) => new Date(localEpoch - offset))
    .filter((candidate) => {
      const local = localPartsAt(candidate, timezone);
      return (
        local?.year === target.year &&
        local.month === target.month &&
        local.day === target.day &&
        local.hour === target.hour &&
        local.minute === target.minute
      );
    });
  return candidates.length === 1 ? candidates[0]!.toISOString() : null;
}

interface TaskCardProps {
  readonly task: TodayTaskDto;
  readonly timezone: string;
  readonly replacementDueValue: string;
  readonly completing: boolean;
  readonly mutationMessage: TaskMutationMessage | null;
  readonly retryAvailable: boolean;
  readonly onDueChange: (value: string) => void;
  readonly onComplete: () => void;
  readonly onRetry: () => void;
  readonly canAssign: boolean;
  readonly assignmentOpen: boolean;
  readonly assignmentOptions: readonly CustomerAssignmentOptionDto[];
  readonly assignmentLoading: boolean;
  readonly assignmentSaving: boolean;
  readonly selectedAssignee: string;
  readonly assignmentMessage: TaskMutationMessage | null;
  readonly assignmentRetryAvailable: boolean;
  readonly onToggleAssignment: () => void;
  readonly onAssigneeChange: (value: string) => void;
  readonly onSaveAssignment: () => void;
  readonly onRetryAssignment: () => void;
  readonly getCsrfToken: () => Promise<string>;
  readonly invalidateCsrfToken: () => void;
  readonly onTerminalOutcome: () => void;
  readonly refreshCompletionVersions: () => Promise<{
    renewalVersion: number;
    taskVersion: number;
  }>;
}

function TaskCard({
  task,
  timezone,
  replacementDueValue,
  completing,
  mutationMessage,
  retryAvailable,
  onDueChange,
  onComplete,
  onRetry,
  canAssign,
  assignmentOpen,
  assignmentOptions,
  assignmentLoading,
  assignmentSaving,
  selectedAssignee,
  assignmentMessage,
  assignmentRetryAvailable,
  onToggleAssignment,
  onAssigneeChange,
  onSaveAssignment,
  onRetryAssignment,
  getCsrfToken,
  invalidateCsrfToken,
  onTerminalOutcome,
  refreshCompletionVersions,
}: TaskCardProps) {
  return (
    <article
      aria-labelledby={`task-${task.taskId}-customer`}
      style={{
        background: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: '0.5rem',
        padding: '1rem',
        display: 'grid',
        gap: '0.45rem',
      }}
    >
      <h4 id={`task-${task.taskId}-customer`} style={{ margin: 0, fontSize: '1rem' }}>
        {task.customerDisplayName}
      </h4>
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', color: '#475569' }}>
        {task.policyNumber && <span>Poliçe: {task.policyNumber}</span>}
        {task.policyEndDate && <span>Bitiş: {task.policyEndDate}</span>}
      </div>
      <p style={{ margin: 0, color: '#475569' }}>{task.title}</p>
      <p style={{ margin: 0, fontWeight: 600 }}>
        Sonraki işlem: {formatDueAt(task.dueAt, timezone)}
      </p>
      {task.customerPhone && <p style={{ margin: 0 }}>Telefon: {task.customerPhone}</p>}
      {task.customerEmail && <p style={{ margin: 0 }}>E-posta: {task.customerEmail}</p>}
      {task.isUnassigned && <span style={{ color: '#92400e' }}>Atanmamış</span>}
      {task.needsReassignment && (
        <p style={{ color: '#92400e' }}>Önceki sorumlu pasif veya askıda; açık takip korunuyor.</p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onComplete();
        }}
        style={{ display: 'grid', gap: '0.5rem', marginTop: '0.5rem' }}
      >
        <label htmlFor={`task-${task.taskId}-replacement-due`}>
          Yeni takip zamanı: {task.customerDisplayName}
        </label>
        <input
          id={`task-${task.taskId}-replacement-due`}
          type="datetime-local"
          value={replacementDueValue}
          onChange={(event) => onDueChange(event.target.value)}
          required
        />
        <button type="submit" disabled={completing}>
          {completing
            ? 'Kaydediliyor…'
            : `Takibi tamamla ve yenisini planla: ${task.customerDisplayName}`}
        </button>
      </form>
      {retryAvailable && (
        <button type="button" disabled={completing} onClick={onRetry}>
          Aynı işlemi yeniden dene: {task.customerDisplayName}
        </button>
      )}
      {mutationMessage?.taskId === task.taskId && mutationMessage.error && (
        <p role="alert">{mutationMessage.error}</p>
      )}
      {mutationMessage?.taskId === task.taskId && mutationMessage.success && (
        <p role="status">{mutationMessage.success}</p>
      )}
      {canAssign && (
        <div style={{ display: 'grid', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button type="button" onClick={onToggleAssignment}>
            {assignmentOpen
              ? `Atama seçeneklerini gizle: ${task.customerDisplayName}`
              : `Atama seçeneklerini aç: ${task.customerDisplayName}`}
          </button>
          {assignmentOpen && (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {assignmentLoading && <p role="status">Atanabilecek kişiler yükleniyor…</p>}
              {assignmentMessage?.taskId === task.taskId && assignmentMessage.error && (
                <p role="alert">{assignmentMessage.error}</p>
              )}
              {!assignmentLoading && (
                <>
                  <label htmlFor={`task-${task.taskId}-assignee`}>
                    Yeni sorumlu: {task.customerDisplayName}
                  </label>
                  <select
                    id={`task-${task.taskId}-assignee`}
                    aria-label={`Yeni sorumlu: ${task.customerDisplayName}`}
                    value={selectedAssignee}
                    onChange={(event) => onAssigneeChange(event.target.value)}
                  >
                    <option value="">
                      {task.needsReassignment ? 'Aktif çalışan seçin' : 'Atanmamış'}
                    </option>
                    {assignmentOptions.map((option) => (
                      <option key={option.membershipId} value={option.membershipId}>
                        {option.label} ({option.membershipType})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={
                      assignmentSaving ||
                      (task.needsReassignment &&
                        !assignmentOptions.some(
                          (option) => option.membershipId === selectedAssignee,
                        ))
                    }
                    onClick={onSaveAssignment}
                  >
                    {assignmentSaving
                      ? 'Kaydediliyor…'
                      : `Atamayı kaydet: ${task.customerDisplayName}`}
                  </button>
                </>
              )}
              {assignmentRetryAvailable && (
                <button type="button" disabled={assignmentSaving} onClick={onRetryAssignment}>
                  Aynı atamayı yeniden dene: {task.customerDisplayName}
                </button>
              )}
              {assignmentMessage?.taskId === task.taskId && assignmentMessage.success && (
                <p role="status">{assignmentMessage.success}</p>
              )}
            </div>
          )}
        </div>
      )}
      <RenewalWorkspacePanel
        renewalId={task.renewalId}
        customerId={task.customerId}
        taskId={task.taskId}
        customerDisplayName={task.customerDisplayName}
        renewalVersion={task.renewalVersion}
        taskVersion={task.taskVersion}
        renewalState={task.renewalState}
        getCsrfToken={getCsrfToken}
        invalidateCsrfToken={invalidateCsrfToken}
        onTerminalOutcome={onTerminalOutcome}
        refreshCompletionVersions={refreshCompletionVersions}
      />
    </article>
  );
}

export function TodayWorkPanel({ getCsrfToken, invalidateCsrfToken }: TodayWorkPanelProps) {
  const [data, setData] = useState<TodayTasksResponseData | null>(null);
  const [statisticsRefreshKey, setStatisticsRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMoreQueue, setLoadingMoreQueue] = useState<TaskQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedPage, setFailedPage] = useState<FailedPage | null>(null);
  const [replacementDueValues, setReplacementDueValues] = useState<Record<string, string>>({});
  const [completionAttempt, setCompletionAttempt] = useState<CompletionAttempt | null>(null);
  const [mutationMessage, setMutationMessage] = useState<TaskMutationMessage | null>(null);
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [assignmentOptions, setAssignmentOptions] = useState<
    Record<string, readonly CustomerAssignmentOptionDto[]>
  >({});
  const [assignmentPanels, setAssignmentPanels] = useState<Record<string, boolean>>({});
  const [selectedAssignees, setSelectedAssignees] = useState<Record<string, string>>({});
  const [assignmentAttempt, setAssignmentAttempt] = useState<AssignmentAttempt | null>(null);
  const [assignmentMessage, setAssignmentMessage] = useState<TaskMutationMessage | null>(null);
  const [loadingAssignmentOptionsTaskId, setLoadingAssignmentOptionsTaskId] = useState<
    string | null
  >(null);
  const [savingAssignmentTaskId, setSavingAssignmentTaskId] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const viewGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const assignmentOptionRequests = useRef(new Map<string, number>());
  // Remember the page that disclosed each task; refreshing a conflict must not
  // reload/unmount the workspace or silently discard a later-page draft.
  const completionPages = useRef(new Map<string, string>());
  const reassignmentMode = useRef(false);
  const [showReassignment, setShowReassignment] = useState(false);

  const loadTasks = useCallback(
    async (cursor: string | null, append: boolean, queue: TaskQueue = 'WORK') => {
      const generation = ++requestGeneration.current;
      activeController.current?.abort();
      const controller = new AbortController();
      activeController.current = controller;
      if (append) setLoadingMoreQueue(queue);
      else setLoading(true);
      setError(null);
      setFailedPage(null);

      try {
        const parameters = new URLSearchParams();
        if (reassignmentMode.current) parameters.set('needsReassignment', 'true');
        if (queue === 'WORK' && cursor) parameters.set('cursor', cursor);
        if (queue === 'UNASSIGNED' && cursor) parameters.set('unassignedCursor', cursor);
        const query = parameters.toString();
        const response = await fetch(`/api/tasks/today${query ? `?${query}` : ''}`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new TaskListRequestError(response.status);
        const envelope = (await response.json()) as ApiResponse<TodayTasksResponseData>;
        if (!envelope.success) throw new TaskListRequestError(response.status);
        // Historical renewal-only adapter never opens a GENERAL Task as a renewal.
        const renewalOnly = (task: { kind?: string }) => task.kind !== 'GENERAL';
        (
          envelope.data as {
            items: readonly TodayTaskDto[];
            unassignedItems: readonly TodayTaskDto[];
          }
        ).items = envelope.data.items.filter(renewalOnly);
        (
          envelope.data as {
            items: readonly TodayTaskDto[];
            unassignedItems: readonly TodayTaskDto[];
          }
        ).unassignedItems = envelope.data.unassignedItems.filter(renewalOnly);
        if (generation !== requestGeneration.current) return;
        if (!append) setStatisticsRefreshKey((value) => value + 1);
        for (const task of envelope.data.items) completionPages.current.set(task.taskId, query);
        for (const task of envelope.data.unassignedItems)
          completionPages.current.set(task.taskId, query);
        setData((previous) => {
          if (!append || !previous) return envelope.data;
          if (queue === 'WORK') {
            const seen = new Set(previous.items.map((task) => task.taskId));
            return {
              ...envelope.data,
              items: [
                ...previous.items,
                ...envelope.data.items.filter((task) => !seen.has(task.taskId)),
              ],
              unassignedItems: previous.unassignedItems,
              unassignedHasMore: previous.unassignedHasMore,
              unassignedNextCursor: previous.unassignedNextCursor,
            };
          }
          const seen = new Set(previous.unassignedItems.map((task) => task.taskId));
          return {
            ...envelope.data,
            items: previous.items,
            hasMore: previous.hasMore,
            nextCursor: previous.nextCursor,
            unassignedItems: [
              ...previous.unassignedItems,
              ...envelope.data.unassignedItems.filter((task) => !seen.has(task.taskId)),
            ],
          };
        });
      } catch (caught) {
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        if (
          !append ||
          (caught instanceof TaskListRequestError &&
            (caught.status === 403 || caught.status === 404))
        ) {
          setData(null);
        }
        setError(safeErrorMessage(caught));
        if (append && cursor) setFailedPage({ queue, cursor });
      } finally {
        if (generation === requestGeneration.current) {
          setLoading(false);
          setLoadingMoreQueue(null);
        }
      }
    },
    [],
  );

  const runCompletionAttempt = useCallback(
    async (attempt: CompletionAttempt, csrfRetried = false) => {
      const activeView = viewGeneration.current;
      setCompletionAttempt(attempt);
      setCompletingTaskId(attempt.taskId);
      setMutationMessage({ taskId: attempt.taskId, error: null, success: null });

      try {
        const csrfToken = await getCsrfToken();
        if (activeView !== viewGeneration.current) return;
        const response = await fetch(attempt.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
            'Idempotency-Key': attempt.idempotencyKey,
          },
          body: attempt.body,
        });
        const envelope = (await response
          .clone()
          .json()
          .catch(() => null)) as { success?: boolean; error?: { code?: string } } | null;
        if (
          response.status === 403 &&
          !csrfRetried &&
          typeof envelope?.error?.code === 'string' &&
          envelope.error.code.startsWith('CSRF_')
        ) {
          invalidateCsrfToken();
          await runCompletionAttempt(attempt, true);
          return;
        }
        if (activeView !== viewGeneration.current) return;
        if (!response.ok || !envelope?.success) {
          if (response.status >= 500 || response.status === 429) {
            setMutationMessage({
              taskId: attempt.taskId,
              error: 'İşlem sonucu doğrulanamadı. Aynı isteği güvenle yeniden deneyebilirsiniz.',
              success: null,
            });
          } else {
            setCompletionAttempt(null);
            const message =
              response.status === 409
                ? 'Kayıt güncellendi. Listeyi yenileyip yeniden deneyin.'
                : 'Takip tamamlanamadı. Kayıt veya yetkiyi denetleyin.';
            setMutationMessage({ taskId: attempt.taskId, error: message, success: null });
          }
          return;
        }
        setCompletionAttempt(null);
        setMutationMessage({
          taskId: attempt.taskId,
          error: null,
          success: 'Yeni takip planlandı.',
        });
        setCompletingTaskId(null);
        await loadTasks(null, false);
      } catch {
        if (activeView !== viewGeneration.current) return;
        setMutationMessage({
          taskId: attempt.taskId,
          error: 'İşlem sonucu doğrulanamadı. Aynı isteği güvenle yeniden deneyebilirsiniz.',
          success: null,
        });
      } finally {
        if (activeView === viewGeneration.current) setCompletingTaskId(null);
      }
    },
    [getCsrfToken, invalidateCsrfToken, loadTasks],
  );

  const handleComplete = useCallback(
    (task: TodayTaskDto) => {
      const replacementDueValue =
        replacementDueValues[task.taskId] ??
        defaultReplacementDueValue(task.dueAt, data?.timezone ?? 'Europe/Istanbul');
      const replacementDueAt = localDateTimeToUtc(
        replacementDueValue,
        data?.timezone ?? 'Europe/Istanbul',
      );
      if (!replacementDueAt) {
        setMutationMessage({
          taskId: task.taskId,
          error: 'Yeni takip zamanını acente saatinde geçerli biçimde seçin.',
          success: null,
        });
        return;
      }
      const body = JSON.stringify({
        expectedRenewalVersion: task.renewalVersion,
        expectedTaskVersion: task.taskVersion,
        replacementDueAt,
      });
      const previous = completionAttempt;
      const attempt: CompletionAttempt =
        previous?.taskId === task.taskId && previous.body === body
          ? previous
          : {
              renewalId: task.renewalId,
              taskId: task.taskId,
              url: `/api/renewals/${encodeURIComponent(task.renewalId)}/tasks/${encodeURIComponent(task.taskId)}/complete`,
              body,
              idempotencyKey: crypto.randomUUID(),
            };
      void runCompletionAttempt(attempt);
    },
    [completionAttempt, data?.timezone, replacementDueValues, runCompletionAttempt],
  );

  const loadAssignmentOptions = useCallback(async (task: TodayTaskDto) => {
    const taskId = task.taskId;
    const requestId = (assignmentOptionRequests.current.get(taskId) ?? 0) + 1;
    assignmentOptionRequests.current.set(taskId, requestId);
    const activeView = viewGeneration.current;
    setLoadingAssignmentOptionsTaskId(taskId);
    setAssignmentMessage({ taskId, error: null, success: null });
    try {
      const url = `/api/renewals/${encodeURIComponent(task.renewalId)}/tasks/${encodeURIComponent(taskId)}/assignment-options`;
      const response = await fetch(url, { method: 'GET', cache: 'no-store' });
      if (!response.ok) throw new TaskListRequestError(response.status);
      const envelope = (await response.json()) as ApiResponse<
        readonly CustomerAssignmentOptionDto[]
      >;
      if (!envelope.success) throw new TaskListRequestError(response.status);
      if (
        activeView !== viewGeneration.current ||
        assignmentOptionRequests.current.get(taskId) !== requestId
      ) {
        return;
      }
      setAssignmentOptions((previous) => ({ ...previous, [taskId]: envelope.data }));
      setSelectedAssignees((previous) => {
        const selected =
          previous[taskId] ?? (task.needsReassignment ? '' : task.assigneeMembershipId) ?? '';
        const candidateExists = envelope.data.some((option) => option.membershipId === selected);
        return { ...previous, [taskId]: selected === '' || candidateExists ? selected : '' };
      });
    } catch (caught) {
      if (
        activeView !== viewGeneration.current ||
        assignmentOptionRequests.current.get(taskId) !== requestId
      ) {
        return;
      }
      const message =
        caught instanceof TaskListRequestError && (caught.status === 403 || caught.status === 404)
          ? 'Atama seçenekleri bu iş için kullanılamıyor.'
          : 'Atanabilecek kişiler yüklenemedi. Yeniden deneyin.';
      setAssignmentMessage({ taskId, error: message, success: null });
    } finally {
      if (
        activeView === viewGeneration.current &&
        assignmentOptionRequests.current.get(taskId) === requestId
      ) {
        setLoadingAssignmentOptionsTaskId(null);
      }
    }
  }, []);

  const runAssignmentAttempt = useCallback(
    async (attempt: AssignmentAttempt, csrfRetried = false) => {
      const activeView = viewGeneration.current;
      setAssignmentAttempt(attempt);
      setSavingAssignmentTaskId(attempt.taskId);
      setAssignmentMessage({ taskId: attempt.taskId, error: null, success: null });
      try {
        const csrfToken = await getCsrfToken();
        if (activeView !== viewGeneration.current) return;
        const response = await fetch(attempt.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
            'Idempotency-Key': attempt.idempotencyKey,
          },
          body: attempt.body,
        });
        const envelope = (await response
          .clone()
          .json()
          .catch(() => null)) as { success?: boolean; error?: { code?: string } } | null;
        if (activeView !== viewGeneration.current) return;
        if (
          response.status === 403 &&
          !csrfRetried &&
          typeof envelope?.error?.code === 'string' &&
          envelope.error.code.startsWith('CSRF_')
        ) {
          invalidateCsrfToken();
          await runAssignmentAttempt(attempt, true);
          return;
        }
        if (activeView !== viewGeneration.current) return;
        if (!response.ok || !envelope?.success) {
          if (response.status >= 500 || response.status === 429) {
            setAssignmentMessage({
              taskId: attempt.taskId,
              error: 'Atama sonucu doğrulanamadı. Aynı atamayı güvenle yeniden deneyebilirsiniz.',
              success: null,
            });
          } else {
            setAssignmentAttempt(null);
            setAssignmentMessage({
              taskId: attempt.taskId,
              error:
                response.status === 409
                  ? 'Kayıt güncellendi. Listeyi yenileyip yeniden deneyin.'
                  : 'Atama tamamlanamadı. Kayıt veya yetkiyi denetleyin.',
              success: null,
            });
          }
          return;
        }
        setAssignmentAttempt(null);
        setAssignmentMessage({
          taskId: attempt.taskId,
          error: null,
          success: 'Atama güncellendi.',
        });
        setSavingAssignmentTaskId(null);
        await loadTasks(null, false);
      } catch {
        if (activeView !== viewGeneration.current) return;
        setAssignmentMessage({
          taskId: attempt.taskId,
          error: 'Atama sonucu doğrulanamadı. Aynı atamayı güvenle yeniden deneyebilirsiniz.',
          success: null,
        });
      } finally {
        if (activeView === viewGeneration.current) setSavingAssignmentTaskId(null);
      }
    },
    [getCsrfToken, invalidateCsrfToken, loadTasks],
  );

  const toggleAssignment = useCallback(
    (task: TodayTaskDto) => {
      const isOpen = assignmentPanels[task.taskId] ?? false;
      setAssignmentPanels((previous) => ({ ...previous, [task.taskId]: !isOpen }));
      if (!isOpen && !assignmentOptions[task.taskId]) void loadAssignmentOptions(task);
    },
    [assignmentOptions, assignmentPanels, loadAssignmentOptions],
  );

  const handleSaveAssignment = useCallback(
    (task: TodayTaskDto) => {
      const selected = selectedAssignees[task.taskId] ?? task.assigneeMembershipId ?? '';
      if (
        task.needsReassignment &&
        !assignmentOptions[task.taskId]?.some((option) => option.membershipId === selected)
      ) {
        setAssignmentMessage({
          taskId: task.taskId,
          error: 'Uygun bir aktif çalışan seçin.',
          success: null,
        });
        return;
      }
      const body = JSON.stringify({
        expectedRenewalVersion: task.renewalVersion,
        expectedTaskVersion: task.taskVersion,
        assigneeMembershipId: selected || null,
      });
      const previous = assignmentAttempt;
      const attempt: AssignmentAttempt =
        previous?.taskId === task.taskId && previous.body === body
          ? previous
          : {
              taskId: task.taskId,
              url: `/api/renewals/${encodeURIComponent(task.renewalId)}/tasks/${encodeURIComponent(task.taskId)}/assign`,
              body,
              idempotencyKey: crypto.randomUUID(),
            };
      void runAssignmentAttempt(attempt);
    },
    [assignmentAttempt, assignmentOptions, runAssignmentAttempt, selectedAssignees],
  );

  useEffect(() => {
    viewGeneration.current += 1;
    void loadTasks(null, false);
    return () => {
      viewGeneration.current += 1;
      requestGeneration.current += 1;
      activeController.current?.abort();
    };
  }, [loadTasks]);

  const assignedTasks = useMemo(() => data?.items ?? [], [data]);
  const overdue = assignedTasks.filter((task) => task.bucket === 'OVERDUE');
  const dueToday = assignedTasks.filter((task) => task.bucket === 'TODAY');
  const upcoming = assignedTasks.filter((task) => task.bucket === 'UPCOMING');
  const unassigned = data?.unassignedItems ?? [];

  const renderTasks = (tasks: readonly TodayTaskDto[]) =>
    tasks.length > 0 ? (
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        {tasks.map((task) => (
          <TaskCard
            key={task.taskId}
            task={task}
            timezone={data?.timezone ?? 'Europe/Istanbul'}
            replacementDueValue={
              replacementDueValues[task.taskId] ??
              defaultReplacementDueValue(task.dueAt, data?.timezone ?? 'Europe/Istanbul')
            }
            completing={completingTaskId === task.taskId}
            mutationMessage={mutationMessage}
            retryAvailable={
              completionAttempt?.taskId === task.taskId && Boolean(mutationMessage?.error)
            }
            onDueChange={(value) =>
              setReplacementDueValues((previous) => ({ ...previous, [task.taskId]: value }))
            }
            onComplete={() => handleComplete(task)}
            onRetry={() => {
              if (completionAttempt?.taskId === task.taskId) {
                void runCompletionAttempt(completionAttempt);
              }
            }}
            canAssign={data?.canAssign ?? false}
            assignmentOpen={assignmentPanels[task.taskId] ?? false}
            assignmentOptions={assignmentOptions[task.taskId] ?? []}
            assignmentLoading={loadingAssignmentOptionsTaskId === task.taskId}
            assignmentSaving={savingAssignmentTaskId === task.taskId}
            selectedAssignee={selectedAssignees[task.taskId] ?? task.assigneeMembershipId ?? ''}
            assignmentMessage={assignmentMessage}
            assignmentRetryAvailable={
              assignmentAttempt?.taskId === task.taskId && Boolean(assignmentMessage?.error)
            }
            onToggleAssignment={() => toggleAssignment(task)}
            onAssigneeChange={(value) =>
              setSelectedAssignees((previous) => ({ ...previous, [task.taskId]: value }))
            }
            onSaveAssignment={() => handleSaveAssignment(task)}
            onRetryAssignment={() => {
              if (assignmentAttempt?.taskId === task.taskId) {
                void runAssignmentAttempt(assignmentAttempt);
              }
            }}
            getCsrfToken={getCsrfToken}
            invalidateCsrfToken={invalidateCsrfToken}
            onTerminalOutcome={() => void loadTasks(null, false, 'WORK')}
            refreshCompletionVersions={async () => {
              const query = completionPages.current.get(task.taskId);
              if (query === undefined) throw new Error('TASK_PAGE_UNAVAILABLE');
              const response = await fetch(`/api/tasks/today${query ? `?${query}` : ''}`, {
                method: 'GET',
                cache: 'no-store',
              });
              if (!response.ok) throw new Error('TASK_REFRESH_DENIED');
              const envelope = (await response.json()) as ApiResponse<TodayTasksResponseData>;
              if (!envelope.success) throw new Error('TASK_REFRESH_FAILED');
              const current = [...envelope.data.items, ...envelope.data.unassignedItems].find(
                (item) => item.taskId === task.taskId && item.renewalId === task.renewalId,
              );
              if (
                !current ||
                !Number.isSafeInteger(current.renewalVersion) ||
                !Number.isSafeInteger(current.taskVersion)
              )
                throw new Error('TASK_NO_LONGER_ON_PAGE');
              return { renewalVersion: current.renewalVersion, taskVersion: current.taskVersion };
            }}
          />
        ))}
      </div>
    ) : (
      <p style={{ color: '#64748b' }}>Bu bölümde açık takip yok.</p>
    );

  return (
    <section aria-labelledby="today-work-title" style={{ display: 'grid', gap: '1.25rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 id="today-work-title" style={{ margin: 0, fontSize: '1.5rem' }}>
            Bugünkü İşler
          </h2>
          {data && (
            <p style={{ color: '#64748b', margin: '0.35rem 0 0' }}>
              Acente saati: {data.timezone} · {data.todayLocalDate}
            </p>
          )}
        </div>
        <button type="button" onClick={() => void loadTasks(null, false)}>
          Yenile
        </button>
      </div>

      <TaskStatisticsPanel refreshKey={statisticsRefreshKey} />

      {data?.canSeeReassignment && (
        <nav aria-label="İş görünümü" style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            type="button"
            aria-pressed={!showReassignment}
            onClick={() => {
              reassignmentMode.current = false;
              setShowReassignment(false);
              viewGeneration.current++;
              setAssignmentAttempt(null);
              setSavingAssignmentTaskId(null);
              setLoadingAssignmentOptionsTaskId(null);
              setAssignmentMessage(null);
              setAssignmentOptions({});
              setAssignmentPanels({});
              setSelectedAssignees({});
              void loadTasks(null, false);
            }}
          >
            Tüm açık takipler
          </button>
          <button
            type="button"
            aria-pressed={showReassignment}
            onClick={() => {
              reassignmentMode.current = true;
              setShowReassignment(true);
              viewGeneration.current++;
              setAssignmentAttempt(null);
              setSavingAssignmentTaskId(null);
              setLoadingAssignmentOptionsTaskId(null);
              setAssignmentMessage(null);
              setAssignmentOptions({});
              setAssignmentPanels({});
              setSelectedAssignees({});
              void loadTasks(null, false);
            }}
          >
            Yeniden Atama Gerekenler
          </button>
        </nav>
      )}
      {loading && <p role="status">Görevler yükleniyor…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && data && (
        <>
          {data.canAssign && (
            <p style={{ color: '#475569', margin: 0 }}>
              Görevleri acente kuyruğundan atayabilirsiniz.
            </p>
          )}
          {showReassignment ? (
            <section aria-labelledby="reassignment-tasks-title">
              <h3 id="reassignment-tasks-title">Yeniden Atama Gerekenler</h3>
              <p>
                Pasif veya askıya alınmış sorumlulardaki açık takipler. Kayıtlar otomatik
                aktarılmaz; uygun aktif çalışanı seçip onaylayın.
              </p>
              {renderTasks(assignedTasks)}
            </section>
          ) : (
            <>
              <section
                aria-labelledby="overdue-tasks-title"
                style={{ display: 'grid', gap: '0.75rem' }}
              >
                <h3 id="overdue-tasks-title" style={{ margin: 0 }}>
                  Geciken Takipler
                </h3>
                {renderTasks(overdue)}
              </section>
              <section
                aria-labelledby="today-tasks-title"
                style={{ display: 'grid', gap: '0.75rem' }}
              >
                <h3 id="today-tasks-title" style={{ margin: 0 }}>
                  Bugünkü Takipler
                </h3>
                {renderTasks(dueToday)}
              </section>
              <section
                aria-labelledby="upcoming-tasks-title"
                style={{ display: 'grid', gap: '0.75rem' }}
              >
                <h3 id="upcoming-tasks-title" style={{ margin: 0 }}>
                  Yaklaşan Takipler
                </h3>
                {renderTasks(upcoming)}
              </section>
            </>
          )}
          {data.canSeeUnassigned && (
            <section
              aria-labelledby="unassigned-tasks-title"
              style={{ display: 'grid', gap: '0.75rem' }}
            >
              <h3 id="unassigned-tasks-title" style={{ margin: 0 }}>
                Atanmamış İşler
              </h3>
              {renderTasks(unassigned)}
            </section>
          )}
          {failedPage && (
            <button
              type="button"
              disabled={loadingMoreQueue !== null}
              onClick={() => void loadTasks(failedPage.cursor, true, failedPage.queue)}
            >
              {loadingMoreQueue ? 'Yükleniyor…' : 'Aynı sayfayı yeniden dene'}
            </button>
          )}
          {failedPage?.queue !== 'WORK' && data.hasMore && data.nextCursor && (
            <button
              type="button"
              disabled={loadingMoreQueue !== null}
              onClick={() => void loadTasks(data.nextCursor, true, 'WORK')}
            >
              {loadingMoreQueue === 'WORK' ? 'Yükleniyor…' : 'Daha fazla göster'}
            </button>
          )}
          {data.canSeeUnassigned &&
            failedPage?.queue !== 'UNASSIGNED' &&
            data.unassignedHasMore &&
            data.unassignedNextCursor && (
              <button
                type="button"
                disabled={loadingMoreQueue !== null}
                onClick={() => void loadTasks(data.unassignedNextCursor, true, 'UNASSIGNED')}
              >
                {loadingMoreQueue === 'UNASSIGNED' ? 'Yükleniyor…' : 'Daha fazla atanmamış iş'}
              </button>
            )}
        </>
      )}
    </section>
  );
}

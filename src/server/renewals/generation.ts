import { z } from 'zod';

// Four original nine-statement writes leave room below the Free 50-query ceiling.
export const RENEWAL_GENERATION_BATCH_SIZE = 4;
export const RENEWAL_CONTINUATION_CRON = '* * * * *';

type GenerationAgencyRow = {
  status: 'PROVISIONING' | 'ACTIVE';
  timezone: string;
  renewal_window_days: number;
  last_successful_local_date: string | null;
  cursor_updated_at: string | null;
  cursor_version: number | null;
  continuation_json: string | null;
};

type RenewalCandidateRow = {
  policy_id: string;
  customer_id: string;
  end_date: string;
  assignee_membership_id: string | null;
};

type ExistingRenewalRow = {
  id: string;
  state: string;
  initial_history_count: number;
  task_count: number;
  system_audit_count: number;
};

export class RenewalGenerationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RenewalGenerationError';
    this.code = code;
  }
}

function datePart(parts: Intl.DateTimeFormatPart[], type: string): number {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value || !/^\d+$/.test(value)) throw new RenewalGenerationError('TIMEZONE_DATE_INVALID');
  return Number(value);
}

function zonedParts(value: Date, timezone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(value);
  } catch {
    throw new RenewalGenerationError('TIMEZONE_INVALID');
  }
  return {
    year: datePart(parts, 'year'),
    month: datePart(parts, 'month'),
    day: datePart(parts, 'day'),
    hour: datePart(parts, 'hour'),
    minute: datePart(parts, 'minute'),
    second: datePart(parts, 'second'),
  };
}

function localDate(value: Date, timezone: string): string {
  const parts = zonedParts(value, timezone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addLocalDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day! + days));
  return value.toISOString().slice(0, 10);
}

function isBusinessDay(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) throw new RenewalGenerationError('TIMEZONE_DATE_INVALID');
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function nextBusinessDay(date: string): string {
  let candidate = addLocalDays(date, 1);
  while (!isBusinessDay(candidate)) candidate = addLocalDays(candidate, 1);
  return candidate;
}

function localNineAmUtc(date: string, timezone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) throw new RenewalGenerationError('TIMEZONE_DATE_INVALID');
  const approximateUtc = Date.UTC(year, month - 1, day, 9, 0, 0);
  const localAtApproximate = zonedParts(new Date(approximateUtc), timezone);
  const representedAsUtc = Date.UTC(
    localAtApproximate.year,
    localAtApproximate.month - 1,
    localAtApproximate.day,
    localAtApproximate.hour,
    localAtApproximate.minute,
    localAtApproximate.second,
  );
  return new Date(approximateUtc - (representedAsUtc - approximateUtc)).toISOString();
}

function initialFollowupDueAt(now: Date, timezone: string): string {
  const parts = zonedParts(now, timezone);
  const today = localDate(now, timezone);
  if (!isBusinessDay(today)) return localNineAmUtc(nextBusinessDay(today), timezone);
  if (parts.hour < 9) return localNineAmUtc(today, timezone);
  return now.toISOString();
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const continuationSchema = z
  .object({
    through: z.string().refine(isDateOnly),
    lowerDate: z.string().refine(isDateOnly),
    upperDate: z.string().refine(isDateOnly),
    timezone: z.string().min(1).max(128),
    windowDays: z.number().int().min(1).max(120),
    key: z
      .object({ endDate: z.string().refine(isDateOnly), policyId: z.string().min(1).max(128) })
      .strict()
      .nullable(),
  })
  .strict();
type Continuation = z.infer<typeof continuationSchema>;
function parseContinuation(value: string | null): Continuation | null {
  if (value === null) return null;
  try {
    if (value.length > 2048) throw new Error('INVALID_WINDOW');
    const parsed = continuationSchema.parse(JSON.parse(value));
    if (
      parsed.lowerDate > parsed.through ||
      parsed.upperDate !== addLocalDays(parsed.through, parsed.windowDays) ||
      (parsed.key &&
        (parsed.key.endDate < parsed.lowerDate || parsed.key.endDate > parsed.upperDate))
    )
      throw new Error('INVALID_WINDOW');
    return parsed;
  } catch {
    throw new RenewalGenerationError('RENEWAL_GENERATION_CURSOR_INVALID');
  }
}

function cursorStartDate(updatedAt: string, timezone: string): string {
  const normalized = updatedAt.includes('T') ? updatedAt : `${updatedAt.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) {
    throw new RenewalGenerationError('RENEWAL_GENERATION_CURSOR_INVALID');
  }
  return localDate(parsed, timezone);
}

function isUniqueGenerationConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('renewal_opportunities_expiring_policy_uq') ||
    message.includes(
      'UNIQUE constraint failed: renewal_opportunities.agency_id, renewal_opportunities.expiring_policy_id',
    ) ||
    message.includes('system_audit_events_idempotency_uq') ||
    message.includes('tasks_open_renewal_followup_uq')
  );
}

function assertOneChange(db: D1Database, code: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions (id,expected,actual,failure_code)
       SELECT ?,1,changes(),?`,
    )
    .bind(crypto.randomUUID(), code);
}

function liveCandidateAssertion(
  db: D1Database,
  input: {
    readonly agencyId: string;
    readonly candidate: RenewalCandidateRow;
    readonly lowerDate: string;
    readonly upperDate: string;
  },
): D1PreparedStatement {
  const { agencyId, candidate, lowerDate, upperDate } = input;
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions (id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS (
         SELECT 1 FROM agencies a
         JOIN policies p ON p.agency_id=a.id
         JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
         WHERE a.id=? AND a.status='ACTIVE'
           AND p.id=? AND p.status='ACTIVE' AND p.archived_at IS NULL
           AND c.archived_at IS NULL
           AND p.end_date>=? AND p.end_date<=?
           AND ? IS CASE
             WHEN EXISTS (
               SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
               WHERE m.agency_id=p.agency_id AND m.id=p.assignee_membership_id
                 AND m.status='ACTIVE' AND u.status='ACTIVE'
                 AND EXISTS (SELECT 1 FROM auth_identities ai WHERE ai.user_id=u.id AND ai.status='ACTIVE')
             ) THEN p.assignee_membership_id
             WHEN EXISTS (
               SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
               WHERE m.agency_id=c.agency_id AND m.id=c.assignee_membership_id
                 AND m.status='ACTIVE' AND u.status='ACTIVE'
                 AND EXISTS (SELECT 1 FROM auth_identities ai WHERE ai.user_id=u.id AND ai.status='ACTIVE')
             ) THEN c.assignee_membership_id
             ELSE NULL
           END
       ) THEN 1 ELSE 0 END,'RENEWAL_GENERATION_TARGET_CHANGED'`,
    )
    .bind(
      crypto.randomUUID(),
      agencyId,
      candidate.policy_id,
      lowerDate,
      upperDate,
      candidate.assignee_membership_id,
    );
}

function renewalInsert(
  db: D1Database,
  input: {
    readonly id: string;
    readonly agencyId: string;
    readonly policyId: string;
    readonly assigneeMembershipId: string | null;
    readonly now: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO renewal_opportunities
         (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
       VALUES (?,?,?,?,'CONTACT_PENDING',1,?,?)`,
    )
    .bind(
      input.id,
      input.agencyId,
      input.policyId,
      input.assigneeMembershipId,
      input.now,
      input.now,
    );
}

function initialHistoryInsert(
  db: D1Database,
  input: {
    readonly id: string;
    readonly agencyId: string;
    readonly renewalId: string;
    readonly now: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO renewal_state_history
         (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
       VALUES (?,?,?,NULL,'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING',?)`,
    )
    .bind(input.id, input.agencyId, input.renewalId, input.now);
}

function primaryTaskInsert(
  db: D1Database,
  input: {
    readonly id: string;
    readonly agencyId: string;
    readonly customerId: string;
    readonly renewalId: string;
    readonly assigneeMembershipId: string | null;
    readonly dueAt: string;
    readonly now: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO tasks
         (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,status,
          actor_kind,version,created_at,updated_at)
       VALUES (?,?,?,?,'RENEWAL_FOLLOWUP','Yenileme takibi',?,?,'OPEN','SYSTEM',1,?,?)`,
    )
    .bind(
      input.id,
      input.agencyId,
      input.customerId,
      input.renewalId,
      input.dueAt,
      input.assigneeMembershipId,
      input.now,
      input.now,
    );
}

function systemAuditInsert(
  db: D1Database,
  input: {
    readonly id: string;
    readonly agencyId: string;
    readonly renewalId: string;
    readonly correlationId: string;
    readonly policyId: string;
    readonly now: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO system_audit_events
         (id,agency_id,system_actor_code,action,target_type,target_id,correlation_id,idempotency_key,
          outcome,reason_code,metadata_json,created_at)
       VALUES (?,?,'renewal-generation','renewal.generate','renewal_opportunities',?,?,?,'SUCCESS',
          'POLICY_EXPIRING','{}',?)`,
    )
    .bind(
      input.id,
      input.agencyId,
      input.renewalId,
      input.correlationId,
      `renewal-policy:${input.policyId}`,
      input.now,
    );
}

// The same exact effect proof is used for scheduled reads and racing creates.
const generationEvidenceColumns = `(SELECT count(*) FROM renewal_state_history h
          WHERE h.agency_id=r.agency_id AND h.renewal_id=r.id
            AND h.from_state IS NULL AND h.to_state='CONTACT_PENDING'
            AND h.actor_kind='SYSTEM' AND h.actor_user_id IS NULL AND h.actor_membership_id IS NULL
            AND h.reason_code='POLICY_EXPIRING') AS initial_history_count,
         (SELECT count(*) FROM tasks t
          WHERE t.agency_id=r.agency_id AND t.renewal_id=r.id
            AND t.kind='RENEWAL_FOLLOWUP' AND t.actor_kind='SYSTEM') AS task_count,
         (SELECT count(*) FROM system_audit_events a
          WHERE a.agency_id=r.agency_id AND a.system_actor_code='renewal-generation'
            AND a.action='renewal.generate' AND a.target_type='renewal_opportunities'
            AND a.target_id=r.id AND a.idempotency_key=('renewal-policy:'||r.expiring_policy_id)
            AND a.outcome='SUCCESS' AND a.reason_code='POLICY_EXPIRING') AS system_audit_count`;

function generationComplete(
  existing: Pick<ExistingRenewalRow, 'initial_history_count' | 'task_count' | 'system_audit_count'>,
): boolean {
  return (
    existing.initial_history_count === 1 &&
    existing.task_count >= 1 &&
    existing.system_audit_count === 1
  );
}

async function assertExistingGenerationComplete(
  db: D1Database,
  agencyId: string,
  policyId: string,
): Promise<void> {
  const existing = await db
    .prepare(
      `SELECT r.id,r.state,${generationEvidenceColumns}
       FROM renewal_opportunities r
       WHERE r.agency_id=? AND r.expiring_policy_id=?`,
    )
    .bind(agencyId, policyId)
    .first<ExistingRenewalRow>();
  if (!existing || !generationComplete(existing)) {
    throw new RenewalGenerationError('RENEWAL_GENERATION_EXISTING_EFFECT_INCOMPLETE');
  }
}

async function createOrObserveRenewal(
  db: D1Database,
  input: {
    readonly agencyId: string;
    readonly candidate: RenewalCandidateRow;
    readonly lowerDate: string;
    readonly upperDate: string;
    readonly timezone: string;
    readonly now: Date;
    readonly correlationId: string;
  },
): Promise<'CREATED' | 'EXISTING'> {
  const renewalId = crypto.randomUUID();
  const now = input.now.toISOString();
  try {
    await db.batch([
      liveCandidateAssertion(db, input),
      renewalInsert(db, {
        id: renewalId,
        agencyId: input.agencyId,
        policyId: input.candidate.policy_id,
        assigneeMembershipId: input.candidate.assignee_membership_id,
        now,
      }),
      assertOneChange(db, 'RENEWAL_GENERATION_RENEWAL_INSERT_FAILED'),
      initialHistoryInsert(db, {
        id: crypto.randomUUID(),
        agencyId: input.agencyId,
        renewalId,
        now,
      }),
      assertOneChange(db, 'RENEWAL_GENERATION_HISTORY_INSERT_FAILED'),
      primaryTaskInsert(db, {
        id: crypto.randomUUID(),
        agencyId: input.agencyId,
        customerId: input.candidate.customer_id,
        renewalId,
        assigneeMembershipId: input.candidate.assignee_membership_id,
        dueAt: initialFollowupDueAt(input.now, input.timezone),
        now,
      }),
      assertOneChange(db, 'RENEWAL_GENERATION_TASK_INSERT_FAILED'),
      systemAuditInsert(db, {
        id: crypto.randomUUID(),
        agencyId: input.agencyId,
        renewalId,
        policyId: input.candidate.policy_id,
        correlationId: input.correlationId,
        now,
      }),
      assertOneChange(db, 'RENEWAL_GENERATION_AUDIT_INSERT_FAILED'),
    ]);
    return 'CREATED';
  } catch (error) {
    if (!isUniqueGenerationConflict(error)) throw error;
    await assertExistingGenerationComplete(db, input.agencyId, input.candidate.policy_id);
    return 'EXISTING';
  }
}

type GenerationWindow = {
  readonly timezone: string;
  readonly today: string;
  readonly lowerDate: string;
  readonly upperDate: string;
  readonly now: Date;
  readonly windowDays: number;
  readonly cursorVersion: number;
  readonly continuation: Continuation | null;
};

async function loadGenerationWindow(
  db: D1Database,
  agencyId: string,
  now: Date,
): Promise<GenerationWindow | null> {
  const settings = await db
    .prepare(
      `SELECT a.status,COALESCE(s.timezone,'Europe/Istanbul') AS timezone,
          COALESCE(s.renewal_window_days,30) AS renewal_window_days,
          g.last_successful_local_date,g.updated_at AS cursor_updated_at,
          g.version AS cursor_version,g.continuation_json
       FROM agencies a
       LEFT JOIN agency_settings s ON s.agency_id=a.id
       LEFT JOIN renewal_generation_cursors g ON g.agency_id=a.id
       WHERE a.id=?`,
    )
    .bind(agencyId)
    .first<GenerationAgencyRow>();
  if (!settings || settings.status !== 'ACTIVE') return null;
  if (
    !Number.isInteger(settings.renewal_window_days) ||
    settings.renewal_window_days < 1 ||
    settings.renewal_window_days > 120
  ) {
    throw new RenewalGenerationError('RENEWAL_WINDOW_INVALID');
  }
  let lastSuccessfulDate = settings.last_successful_local_date;
  let cursorUpdatedAt = settings.cursor_updated_at;
  let cursorVersion = settings.cursor_version;
  let continuationJson = settings.continuation_json;
  if (lastSuccessfulDate && !isDateOnly(lastSuccessfulDate)) {
    throw new RenewalGenerationError('RENEWAL_GENERATION_CURSOR_INVALID');
  }
  const today = localDate(now, settings.timezone);
  if (!cursorUpdatedAt) {
    if (lastSuccessfulDate) throw new RenewalGenerationError('RENEWAL_GENERATION_CURSOR_INVALID');
    const initialized = await db
      .prepare(
        `INSERT INTO renewal_generation_cursors
           (agency_id,last_successful_local_date,version,updated_at)
         VALUES (?,NULL,1,?) ON CONFLICT(agency_id) DO NOTHING`,
      )
      .bind(agencyId, now.toISOString())
      .run();
    if (!initialized.success) {
      throw new RenewalGenerationError('RENEWAL_GENERATION_CURSOR_INITIALIZATION_FAILED');
    }
    const cursor = await db
      .prepare(
        'SELECT last_successful_local_date,updated_at,version,continuation_json FROM renewal_generation_cursors WHERE agency_id=?',
      )
      .bind(agencyId)
      .first<{
        last_successful_local_date: string | null;
        updated_at: unknown;
        version: number;
        continuation_json: string | null;
      }>();
    if (!cursor || typeof cursor.updated_at !== 'string' || cursor.updated_at.trim() === '') {
      throw new RenewalGenerationError('RENEWAL_GENERATION_CURSOR_INVALID');
    }
    lastSuccessfulDate = cursor.last_successful_local_date;
    cursorUpdatedAt = cursor.updated_at;
    cursorVersion = cursor.version;
    continuationJson = cursor.continuation_json;
  }
  if (lastSuccessfulDate && !isDateOnly(lastSuccessfulDate)) {
    throw new RenewalGenerationError('RENEWAL_GENERATION_CURSOR_INVALID');
  }
  const continuation = parseContinuation(continuationJson);
  if (!Number.isSafeInteger(cursorVersion) || cursorVersion! < 1)
    throw new RenewalGenerationError('RENEWAL_GENERATION_CURSOR_INVALID');
  if (continuation && lastSuccessfulDate && continuation.lowerDate !== lastSuccessfulDate)
    throw new RenewalGenerationError('RENEWAL_GENERATION_CURSOR_INVALID');
  return {
    timezone: settings.timezone,
    today,
    lowerDate:
      lastSuccessfulDate ??
      continuation?.lowerDate ??
      cursorStartDate(cursorUpdatedAt, settings.timezone),
    upperDate: addLocalDays(today, settings.renewal_window_days),
    now,
    windowDays: settings.renewal_window_days,
    cursorVersion: cursorVersion!,
    continuation,
  };
}

function pendingQuery(
  agencyId: string,
  pending: Continuation,
  key = pending.key,
  limit = RENEWAL_GENERATION_BATCH_SIZE,
) {
  return {
    sql: `WITH candidates AS (SELECT p.id AS policy_id,p.customer_id,p.end_date,
         CASE
           WHEN EXISTS (
             SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
             WHERE m.agency_id=p.agency_id AND m.id=p.assignee_membership_id
               AND m.status='ACTIVE' AND u.status='ACTIVE'
               AND EXISTS (SELECT 1 FROM auth_identities ai WHERE ai.user_id=u.id AND ai.status='ACTIVE')
           ) THEN p.assignee_membership_id
           WHEN EXISTS (
             SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
             WHERE m.agency_id=c.agency_id AND m.id=c.assignee_membership_id
               AND m.status='ACTIVE' AND u.status='ACTIVE'
               AND EXISTS (SELECT 1 FROM auth_identities ai WHERE ai.user_id=u.id AND ai.status='ACTIVE')
           ) THEN c.assignee_membership_id
           ELSE NULL
         END AS assignee_membership_id,r.id AS existing_renewal_id,${generationEvidenceColumns}
       FROM policies p
       JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
       LEFT JOIN renewal_opportunities r ON r.agency_id=p.agency_id AND r.expiring_policy_id=p.id
       WHERE p.agency_id=? AND p.status='ACTIVE' AND p.archived_at IS NULL
         AND c.archived_at IS NULL AND p.end_date>=? AND p.end_date<=?
         ${key ? 'AND (p.end_date,p.id)>(?,?)' : ''})
       SELECT * FROM candidates WHERE existing_renewal_id IS NULL
         OR initial_history_count<>1 OR task_count<1 OR system_audit_count<>1
       ORDER BY end_date,policy_id LIMIT ?`,
    bindings: [
      agencyId,
      pending.lowerDate,
      pending.upperDate,
      ...(key ? [key.endDate, key.policyId] : []),
      limit,
    ],
  };
}

async function saveContinuation(
  db: D1Database,
  agencyId: string,
  version: number,
  pending: Continuation,
  now: string,
  finish = false,
): Promise<{ completed: boolean; saved: boolean }> {
  const remaining = pendingQuery(agencyId, pending, null, 1);
  const reset = JSON.stringify({ ...pending, key: null });
  const sql = `${finish ? `WITH remaining AS (${remaining.sql})` : ''}
    UPDATE renewal_generation_cursors SET
      last_successful_local_date=${
        finish
          ? `CASE WHEN NOT EXISTS(SELECT 1 FROM remaining)
        AND (last_successful_local_date IS NULL OR last_successful_local_date<?) THEN ? ELSE last_successful_local_date END`
          : 'last_successful_local_date'
      },
      continuation_json=${finish ? 'CASE WHEN EXISTS(SELECT 1 FROM remaining) THEN ? ELSE NULL END' : '?'},
      version=version+1,updated_at=?
    WHERE agency_id=? AND version=? AND EXISTS(SELECT 1 FROM agencies a LEFT JOIN agency_settings s ON s.agency_id=a.id
      WHERE a.id=renewal_generation_cursors.agency_id AND a.status='ACTIVE'
        AND COALESCE(s.timezone,'Europe/Istanbul')=? AND COALESCE(s.renewal_window_days,30)=?)
    RETURNING continuation_json`;
  try {
    const results = await db.batch<{ continuation_json: string | null }>([
      db
        .prepare(sql)
        .bind(
          ...(finish
            ? [...remaining.bindings, pending.through, pending.through, reset]
            : [JSON.stringify(pending)]),
          now,
          agencyId,
          version,
          pending.timezone,
          pending.windowDays,
        ),
      assertOneChange(db, 'RENEWAL_GENERATION_PROGRESS_CHANGED'),
    ]);
    if (results.some((result) => !result.success) || !results[0]?.results[0])
      throw new RenewalGenerationError('RENEWAL_GENERATION_PROGRESS_FAILED');
    return { completed: results[0].results[0].continuation_json === null, saved: true };
  } catch (error) {
    if (error instanceof Error && error.message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT'))
      return { completed: false, saved: false };
    throw error;
  }
}

export async function runRenewalGenerationForAgency(
  db: D1Database,
  agencyId: string,
): Promise<{ createdCount: number; existingCount: number; completedThrough: string | null }> {
  if (!agencyId.trim()) throw new RenewalGenerationError('AGENCY_REQUIRED');
  const current = await loadGenerationWindow(db, agencyId, new Date());
  if (!current) return { createdCount: 0, existingCount: 0, completedThrough: null };
  let pending = current.continuation;
  let version = current.cursorVersion;
  if (
    !pending ||
    pending.timezone !== current.timezone ||
    pending.windowDays !== current.windowDays
  ) {
    pending = {
      through: current.today,
      lowerDate: current.lowerDate,
      upperDate: current.upperDate,
      timezone: current.timezone,
      windowDays: current.windowDays,
      key: null,
    };
    if (!(await saveContinuation(db, agencyId, version, pending, current.now.toISOString())).saved)
      return { createdCount: 0, existingCount: 0, completedThrough: null };
    version++;
  }
  const window = {
    ...current,
    today: pending.through,
    lowerDate: pending.lowerDate,
    upperDate: pending.upperDate,
    timezone: pending.timezone,
  };
  const query = pendingQuery(agencyId, pending);
  const candidates = await db
    .prepare(query.sql)
    .bind(...query.bindings)
    .all<
      RenewalCandidateRow &
        Pick<ExistingRenewalRow, 'initial_history_count' | 'task_count' | 'system_audit_count'> & {
          existing_renewal_id: string | null;
        }
    >();
  if (!candidates.success || !Array.isArray(candidates.results)) {
    throw new RenewalGenerationError('RENEWAL_GENERATION_QUERY_FAILED');
  }

  let createdCount = 0;
  let existingCount = 0;
  const correlationId = crypto.randomUUID();
  for (const candidate of candidates.results) {
    if (
      !candidate ||
      typeof candidate.policy_id !== 'string' ||
      typeof candidate.customer_id !== 'string' ||
      !isDateOnly(candidate.end_date) ||
      (candidate.assignee_membership_id !== null &&
        typeof candidate.assignee_membership_id !== 'string')
    ) {
      throw new RenewalGenerationError('RENEWAL_GENERATION_CANDIDATE_INVALID');
    }
    if (candidate.existing_renewal_id !== null) {
      if (
        typeof candidate.existing_renewal_id !== 'string' ||
        !candidate.existing_renewal_id ||
        !generationComplete(candidate)
      ) {
        throw new RenewalGenerationError('RENEWAL_GENERATION_EXISTING_EFFECT_INCOMPLETE');
      }
      existingCount += 1;
      continue;
    }
    const outcome = await createOrObserveRenewal(db, {
      agencyId,
      candidate,
      lowerDate: window.lowerDate,
      upperDate: window.upperDate,
      timezone: window.timezone,
      now: window.now,
      correlationId,
    });
    if (outcome === 'CREATED') createdCount += 1;
    else existingCount += 1;
  }

  const last = candidates.results.at(-1);
  const progress = {
    ...pending,
    key: last ? { endDate: last.end_date, policyId: last.policy_id } : pending.key,
  };
  // A full page checkpoints only the key. Exhaustion performs a global atomic
  // proof check: policies inserted or moved behind the key force a fresh sweep.
  const saved = await saveContinuation(
    db,
    agencyId,
    version,
    progress,
    window.now.toISOString(),
    candidates.results.length < RENEWAL_GENERATION_BATCH_SIZE,
  );
  return {
    createdCount,
    existingCount,
    completedThrough: saved.completed ? pending.through : null,
  };
}

export async function ensureRenewalForPolicy(
  db: D1Database,
  agencyId: string,
  policyId: string,
): Promise<'CREATED' | 'EXISTING' | 'NOT_ELIGIBLE'> {
  if (!agencyId.trim() || !policyId.trim()) throw new RenewalGenerationError('TARGET_REQUIRED');
  const window = await loadGenerationWindow(db, agencyId, new Date());
  if (!window) return 'NOT_ELIGIBLE';
  const candidate = await db
    .prepare(
      `SELECT p.id AS policy_id,p.customer_id,p.end_date,
         CASE
           WHEN EXISTS (
             SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
             WHERE m.agency_id=p.agency_id AND m.id=p.assignee_membership_id
               AND m.status='ACTIVE' AND u.status='ACTIVE'
               AND EXISTS (SELECT 1 FROM auth_identities ai WHERE ai.user_id=u.id AND ai.status='ACTIVE')
           ) THEN p.assignee_membership_id
           WHEN EXISTS (
             SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id
             WHERE m.agency_id=c.agency_id AND m.id=c.assignee_membership_id
               AND m.status='ACTIVE' AND u.status='ACTIVE'
               AND EXISTS (SELECT 1 FROM auth_identities ai WHERE ai.user_id=u.id AND ai.status='ACTIVE')
           ) THEN c.assignee_membership_id
           ELSE NULL
         END AS assignee_membership_id
       FROM policies p
       JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
       WHERE p.agency_id=? AND p.id=? AND p.status='ACTIVE' AND p.archived_at IS NULL
         AND c.archived_at IS NULL AND p.end_date>=? AND p.end_date<=?`,
    )
    .bind(agencyId, policyId, window.lowerDate, window.upperDate)
    .first<RenewalCandidateRow>();
  if (!candidate) return 'NOT_ELIGIBLE';
  return createOrObserveRenewal(db, {
    agencyId,
    candidate,
    lowerDate: window.lowerDate,
    upperDate: window.upperDate,
    timezone: window.timezone,
    now: window.now,
    correlationId: crypto.randomUUID(),
  });
}

export async function runScheduledRenewalGeneration(
  db: D1Database,
  continuationOnly = false,
): Promise<{ agenciesProcessed: number; createdCount: number; existingCount: number }> {
  // One agency per invocation shares the same conservative statement budget.
  // A durable round-robin turn is independent of progress and wall-clock time:
  // even malformed state or repeatedly failing work must release the next turn.
  const agencyResult = await db
    .prepare(
      `SELECT a.id,COALESCE(s.timezone,'Europe/Istanbul') AS timezone,
      g.last_successful_local_date,g.continuation_json
      FROM agencies a LEFT JOIN agency_settings s ON s.agency_id=a.id
      LEFT JOIN renewal_generation_cursors g ON g.agency_id=a.id
      WHERE a.status='ACTIVE'
      ORDER BY COALESCE(g.last_attempt_order,0),a.id LIMIT 1`,
    )
    .all<{
      id: unknown;
      timezone: string;
      last_successful_local_date: string | null;
      continuation_json: string | null;
    }>();
  if (!agencyResult.success || !Array.isArray(agencyResult.results)) {
    throw new RenewalGenerationError('RENEWAL_GENERATION_AGENCY_QUERY_FAILED');
  }
  let createdCount = 0;
  let existingCount = 0;
  let agenciesProcessed = 0;
  for (const row of agencyResult.results) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) {
      throw new RenewalGenerationError('RENEWAL_GENERATION_AGENCY_ROW_INVALID');
    }
    // Mark BEFORE parsing settings/continuation or writing business effects.
    // Do not alter version, completion date, key, or an existing initial baseline.
    const marked = await db
      .prepare(
        `INSERT INTO renewal_generation_cursors(agency_id,last_attempt_order,updated_at)
      SELECT ?,COALESCE(MAX(last_attempt_order),0)+1,? FROM renewal_generation_cursors WHERE true
      ON CONFLICT(agency_id) DO UPDATE SET last_attempt_order=excluded.last_attempt_order`,
      )
      .bind(row.id, new Date().toISOString())
      .run();
    if (!marked.success)
      throw new RenewalGenerationError('RENEWAL_GENERATION_SCHEDULER_MARK_FAILED');
    if (continuationOnly && row.continuation_json === null) {
      const now = new Date();
      if (
        zonedParts(now, row.timezone).hour < 3 ||
        (row.last_successful_local_date !== null &&
          row.last_successful_local_date >= localDate(now, row.timezone))
      )
        continue;
    }
    const result = await runRenewalGenerationForAgency(db, row.id);
    createdCount += result.createdCount;
    existingCount += result.existingCount;
    agenciesProcessed += 1;
  }
  return { agenciesProcessed, createdCount, existingCount };
}

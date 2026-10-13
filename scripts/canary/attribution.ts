import { z } from 'zod';
export const markerSchema = z.strictObject({
  kind: z.literal('mayi_m4_provider_canary'),
  canary_run_id: z.string().uuid(),
  stage: z.enum([
    'producer_start',
    'queue_start',
    'queue_complete',
    'rpc_client_start',
    'rpc_leaf_start',
    'rpc_leaf_complete',
    'd1_finalization',
    'reconcile_complete',
  ]),
  synthetic_size_bytes: z.union([z.literal(1048576), z.literal(10485760), z.literal(20971520)]),
  synthetic_job_id: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[a-z0-9-]+$/u)
    .nullable(),
  outcome: z.enum(['start', 'ok', 'fail']),
});
// Stored logs may enrich the envelope. Keep emitted identity fields strict.
const storedMarkerSchema = markerSchema.extend({
  synthetic_job_id: markerSchema.shape.synthetic_job_id.transform((id) =>
    id === 'no-job' ? null : id,
  ),
  level: z.enum(['debug', 'info', 'log', 'warn', 'error']).optional(),
});
export interface InvocationContract {
  runId: string;
  size: number;
  from: number;
  to: number;
  invocations: Array<{
    role: string;
    script: string;
    version: string;
    eventTypes: string[];
    jobId: string | null;
    stages: string[];
    providerOutcome?: 'ok' | 'exception';
    markerOutcomes?: Record<string, 'start' | 'ok' | 'fail'>;
  }>;
}
interface Event {
  timestamp: number;
  $metadata: { id: string; type: string };
  $workers: {
    scriptName: string;
    scriptVersion: { id: string };
    eventType: string;
    truncated?: boolean;
    outcome?: string;
    cpuTimeMs?: number;
    wallTimeMs?: number;
  };
  source?: unknown;
}
/** Consume documented Observability view=invocations groups, not timestamp joins.
 * Provider grouping is the association authority. No optional payload request/trace ID used.
 * Raw group keys/log bodies never need to be logged. */
export function assessInvocationGroups(
  input: unknown,
  c: InvocationContract,
): {
  verdict: 'PASS' | 'FAIL' | 'NOT_PROVEN';
  reason: string;
  receipts: Array<{
    role: string;
    eventId: string;
    script: string;
    version: string;
    eventType: string;
    cpuMs: number;
    wallMs: number;
    outcome: string;
  }>;
} {
  const reject = (reason: string, verdict: 'FAIL' | 'NOT_PROVEN' = 'NOT_PROVEN') => ({
    verdict,
    reason,
    receipts: [],
  });
  if (
    !z.string().uuid().safeParse(c.runId).success ||
    ![1048576, 10485760, 20971520].includes(c.size) ||
    !Number.isFinite(c.from) ||
    !Number.isFinite(c.to) ||
    c.from >= c.to ||
    !c.invocations.length
  )
    return reject('CONTRACT');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject('GROUPS');
  const used = new Set<string>(),
    ids = new Set<string>();
  const receipts = [];
  const groups = Object.entries(input as Record<string, unknown>);
  if (groups.length > 30) return reject('BOUND');
  for (const expected of c.invocations) {
    const matches: Array<{
      key: string;
      events: Event[];
      markers: z.infer<typeof markerSchema>[];
    }> = [];
    for (const [key, raw] of groups) {
      if (!Array.isArray(raw) || raw.length > 40) return reject('GROUP_SHAPE');
      const markers: z.infer<typeof markerSchema>[] = [];
      for (const event of raw as Event[]) {
        let source = event.source;
        if (typeof source === 'string') {
          try {
            source = JSON.parse(source);
          } catch {
            source = null;
          }
        }
        if (
          source &&
          typeof source === 'object' &&
          'kind' in source &&
          source.kind === 'mayi_m4_provider_canary'
        ) {
          const parsed = storedMarkerSchema.safeParse(source);
          if (!parsed.success) return reject('UNSAFE_MARKER');
          const m = parsed.data;
          if (m.canary_run_id !== c.runId) continue;
          if (
            m.synthetic_size_bytes !== c.size ||
            !event.$metadata?.id ||
            event.$workers?.scriptName !== expected.script ||
            event.$workers?.scriptVersion?.id !== expected.version
          )
            continue;
          if (m.synthetic_job_id === expected.jobId && expected.stages.includes(m.stage))
            markers.push(m);
        }
      }
      if (markers.length) matches.push({ key, events: raw as Event[], markers });
    }
    if (matches.length !== 1 || used.has(matches[0]!.key))
      return reject('AMBIGUOUS_OR_MISSING_CONTEXT');
    const match = matches[0]!;
    used.add(match.key);
    if (
      match.markers.length !== expected.stages.length ||
      expected.stages.some((s) => match.markers.filter((m) => m.stage === s).length !== 1) ||
      match.markers.some(
        (m) =>
          m.outcome !==
          (expected.markerOutcomes?.[m.stage] ?? (m.stage.endsWith('_start') ? 'start' : 'ok')),
      )
    )
      return reject('MISSING_DUPLICATE_FAILED_STAGE');
    const invocations = match.events.filter((e) => e.$metadata?.type === 'cf-worker-event');
    if (invocations.length !== 1) return reject('AMBIGUOUS_INVOCATION');
    for (const e of match.events) {
      let source = e.source;
      if (typeof source === 'string') {
        try {
          source = JSON.parse(source);
        } catch {
          source = null;
        }
      }
      if (
        source &&
        typeof source === 'object' &&
        'kind' in source &&
        source.kind === 'mayi_m4_provider_canary'
      ) {
        const m = storedMarkerSchema.safeParse(source);
        if (
          !m.success ||
          m.data.canary_run_id !== c.runId ||
          m.data.synthetic_job_id !== expected.jobId ||
          m.data.synthetic_size_bytes !== c.size ||
          !expected.stages.includes(m.data.stage)
        )
          return reject('MIXED_CONTEXT');
      }
      if (
        !e.$metadata?.id ||
        ids.has(e.$metadata.id) ||
        e.$workers?.truncated !== false ||
        e.$workers?.scriptName !== expected.script ||
        e.$workers?.scriptVersion?.id !== expected.version ||
        !expected.eventTypes.includes(e.$workers?.eventType) ||
        !Number.isFinite(e.timestamp) ||
        e.timestamp < c.from ||
        e.timestamp > c.to
      )
        return reject('CONTEXT_DRIFT');
      ids.add(e.$metadata.id);
    }
    const e = invocations[0]!,
      w = e.$workers;
    if (w.outcome !== (expected.providerOutcome ?? 'ok'))
      return reject('PROVIDER_OUTCOME_' + String(w.outcome), 'FAIL');
    if (
      typeof w.cpuTimeMs !== 'number' ||
      !Number.isFinite(w.cpuTimeMs) ||
      w.cpuTimeMs < 0 ||
      typeof w.wallTimeMs !== 'number' ||
      !Number.isFinite(w.wallTimeMs) ||
      w.wallTimeMs < 0
    )
      return reject('MISSING_METRIC');
    receipts.push({
      role: expected.role,
      eventId: e.$metadata.id,
      script: w.scriptName,
      version: w.scriptVersion.id,
      eventType: w.eventType,
      cpuMs: w.cpuTimeMs,
      wallMs: w.wallTimeMs,
      outcome: w.outcome,
    });
  }
  for (const [key, raw] of groups) {
    if (!Array.isArray(raw)) return reject('GROUP_SHAPE');
    for (const e of raw as Event[]) {
      let source = e.source;
      if (typeof source === 'string') {
        try {
          source = JSON.parse(source);
        } catch {
          source = null;
        }
      }
      if (
        source &&
        typeof source === 'object' &&
        'kind' in source &&
        source.kind === 'mayi_m4_provider_canary'
      ) {
        const marker = storedMarkerSchema.safeParse(source);
        if (!marker.success) return reject('UNSAFE_MARKER');
        if (marker.data.canary_run_id === c.runId && !used.has(key))
          return reject('UNEXPECTED_MARKED_INVOCATION');
      }
    }
  }
  return {
    verdict: 'PASS',
    reason: 'EXACT_STRUCTURED_MARKERS_IN_DOCUMENTED_PROVIDER_INVOCATION_GROUPS',
    receipts,
  };
}
export function emitCanaryMarker(
  env: { CANARY_LOGS_ENABLED?: string; CANARY_RUN_ID?: string; CANARY_EXPECTED_SIZE?: string },
  stage: z.infer<typeof markerSchema>['stage'],
  jobId: string | null,
  outcome: 'start' | 'ok' | 'fail',
) {
  if (env.CANARY_LOGS_ENABLED !== 'true') return;
  const safe = markerSchema.parse({
    kind: 'mayi_m4_provider_canary',
    canary_run_id: env.CANARY_RUN_ID,
    stage,
    synthetic_size_bytes: Number(env.CANARY_EXPECTED_SIZE),
    synthetic_job_id: jobId,
    outcome,
  });
  // An explicit sentinel survives stored-log null elision; missing is never inferred.
  if (jobId === 'no-job') throw new Error('RESERVED_CANARY_JOB_ID');
  console.info({ ...safe, synthetic_job_id: safe.synthetic_job_id ?? 'no-job' });
}

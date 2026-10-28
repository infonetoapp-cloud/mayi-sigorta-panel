// @vitest-environment node
import { expect, it } from 'vitest';
async function parser() {
  try {
    return (await import('../scripts/canary/attribution')).assessInvocationGroups;
  } catch {
    return undefined;
  }
}
it('uses provider invocation groups with exact safe marker, never optional request/trace IDs', async () => {
  const assess = await parser();
  expect(typeof assess).toBe('function');
  if (!assess) return;
  const contract = {
    runId: '44444444-1111-4000-8000-000000000001',
    size: 1048576,
    from: 1000,
    to: 2000,
    invocations: [
      {
        role: 'prepare',
        script: 'mayisigorta-m4-canary-test-crm',
        version: '44444444-1111-4000-8000-000000000002',
        eventTypes: ['queue'],
        jobId: null,
        stages: ['producer_start', 'queue_complete'],
      },
    ],
  };
  const custom = (stage: string) => ({
    timestamp: 1500,
    $metadata: { id: stage, type: 'cf-worker' },
    $workers: {
      scriptName: contract.invocations[0]!.script,
      scriptVersion: { id: contract.invocations[0]!.version },
      eventType: 'queue',
      truncated: false,
    },
    source: {
      kind: 'mayi_m4_provider_canary',
      canary_run_id: contract.runId,
      stage,
      synthetic_size_bytes: contract.size,
      synthetic_job_id: null,
      outcome: stage === 'producer_start' ? 'start' : 'ok',
    },
  });
  const cpu = {
    timestamp: 1600,
    $metadata: { id: 'cpu', type: 'cf-worker-event' },
    $workers: {
      scriptName: contract.invocations[0]!.script,
      scriptVersion: { id: contract.invocations[0]!.version },
      eventType: 'queue',
      truncated: false,
      outcome: 'ok',
      cpuTimeMs: 10,
      wallTimeMs: 100,
    },
  };
  const group: Array<
    ReturnType<typeof custom> & {
      $workers: ReturnType<typeof custom>['$workers'] & {
        outcome?: string;
        cpuTimeMs?: number;
        wallTimeMs?: number;
      };
    }
  > = [
    custom('producer_start'),
    custom('queue_complete'),
    { ...cpu, source: undefined as unknown as ReturnType<typeof custom>['source'] },
  ];
  expect(assess({ opaqueProviderGroup: group }, contract).verdict).toBe('PASS');
  const enriched = structuredClone(group);
  for (const event of enriched.slice(0, 2))
    (event.source as Record<string, unknown>).level = 'info';
  expect(assess({ providerGroup: enriched }, contract).verdict).toBe('PASS');
  const sentinel = structuredClone(enriched);
  for (const event of sentinel.slice(0, 2))
    (event.source as Record<string, unknown>).synthetic_job_id = 'no-job';
  expect(assess({ providerGroup: sentinel }, contract).verdict).toBe('PASS');
  const changed = (fn: (g: typeof group) => void) => {
    const g = structuredClone(group);
    fn(g);
    return assess({ opaqueProviderGroup: g }, contract).verdict;
  };
  expect(
    changed((g) => {
      g[0]!.source!.canary_run_id = crypto.randomUUID();
    }),
  ).not.toBe('PASS');
  expect(
    changed((g) => {
      g[0]!.$workers.scriptName = 'wrong';
    }),
  ).not.toBe('PASS');
  expect(
    changed((g) => {
      g[0]!.$workers.scriptVersion.id = crypto.randomUUID();
    }),
  ).not.toBe('PASS');
  expect(
    changed((g) => {
      g[0]!.$workers.eventType = 'fetch';
    }),
  ).not.toBe('PASS');
  expect(assess({ one: group, competing: group }, contract).verdict).not.toBe('PASS');
  for (const outcome of ['ok', 'exception']) {
    const extra = structuredClone(group);
    extra[0]!.source.synthetic_job_id = 'unknown-job' as unknown as null;
    extra[1]!.source.synthetic_job_id = 'unknown-job' as unknown as null;
    extra[2]!.$workers.outcome = outcome;
    expect(assess({ intended: group, extraMarked: extra }, contract).verdict).not.toBe('PASS');
  }
  const wrongSize = structuredClone(group);
  wrongSize[0]!.source.synthetic_size_bytes = 10485760;
  expect(assess({ intended: group, wrongSizeMarked: wrongSize }, contract).verdict).not.toBe(
    'PASS',
  );
  const negative = structuredClone(group);
  negative[1]!.source.outcome = 'fail';
  negative[2]!.$workers.outcome = 'exception';
  const negativeContract = {
    ...contract,
    invocations: [
      {
        ...contract.invocations[0]!,
        providerOutcome: 'exception' as const,
        markerOutcomes: { producer_start: 'start' as const, queue_complete: 'fail' as const },
      },
    ],
  };
  expect(assess({ negativeGroup: negative }, negativeContract).verdict).toBe('PASS');
  expect(assess({ negativeGroup: [negative[0], negative[2]] }, negativeContract).verdict).not.toBe(
    'PASS',
  );
  expect(assess({ negativeGroup: group }, negativeContract).verdict).not.toBe('PASS');
  expect(
    changed((g) => {
      delete (g[2]!.$workers as { cpuTimeMs?: number }).cpuTimeMs;
    }),
  ).toBe('NOT_PROVEN');
  expect(
    changed((g) => {
      delete (g[2]!.$workers as { wallTimeMs?: number }).wallTimeMs;
    }),
  ).toBe('NOT_PROVEN');
  const ids = group.map((g) => ({
    ...g,
    $metadata: { ...g.$metadata, requestId: 'wrong', traceId: 'wrong' },
  }));
  expect(assess({ providerGroup: ids }, contract).verdict).toBe('PASS');
  expect(
    assess(
      {
        providerGroup: group,
        neighboringInventory: [{ ...cpu, $metadata: { id: 'inventory', type: 'cf-worker-event' } }],
      },
      contract,
    ).verdict,
  ).toBe('PASS');
  expect(assess({ providerGroup: group.slice(1) }, contract).verdict).not.toBe('PASS');
  expect(
    changed((g) => {
      (g[0]!.source as Record<string, unknown>).password = 'unsafe-field';
    }),
  ).not.toBe('PASS');
  expect(
    changed((g) => {
      g[0]!.source!.canary_run_id = 'x'.repeat(4096);
    }),
  ).not.toBe('PASS');
  expect(
    changed((g) => {
      g[2]!.$workers.outcome = 'exceededResources';
    }),
  ).toBe('FAIL');
});

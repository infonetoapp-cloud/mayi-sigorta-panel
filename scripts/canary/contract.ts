import { z } from 'zod';
export const CANARY_SIZES = [1048576, 10485760, 20971520] as const;
const startSchema = z.strictObject({
  kind: z.literal('P0_SYNTHETIC_START'),
  runId: z.string().uuid(),
  sizeBytes: z.union([z.literal(1048576), z.literal(10485760), z.literal(20971520)]),
});
export function parseCanaryStart(input: unknown, runId: string) {
  const r = startSchema.safeParse(input);
  if (!r.success || r.data.runId !== runId) throw new Error('CANARY_START_DENIED');
  return r.data;
}
/** Structural eligibility, NOT attestation: original provider receipts must be
 * independently read back and reviewed. Local/fabricated fixtures never accept Free. */
const providerSchema = z.strictObject({
  mode: z.literal('PROVIDER'),
  runId: z.string().uuid(),
  sizeBytes: z.union([z.literal(1048576), z.literal(10485760), z.literal(20971520)]),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  accountPlan: z.literal('WORKERS_FREE'),
  isolationReadback: z.literal(true),
  noProductionData: z.literal(true),
  documentsEnabled: z.literal('false'),
  publicExposure: z.literal(false),
  backupJobCount: z.literal(1),
  reconcileJobCount: z.literal(1),
  objectCount: z.literal(1),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/u),
  verifiedHash: z.string().regex(/^[a-f0-9]{64}$/u),
  verifiedSize: z.number().int().positive(),
  completionAudit: z.literal(1),
  attempts: z.literal(1),
  retries: z.literal(0),
  redeliveries: z.literal(0),
  finalState: z.literal('AVAILABLE'),
  reconcileNoop: z.literal(true),
  healthHealthy: z.literal(true),
  contentLeak: z.literal(false),
  executions: z
    .array(
      z.strictObject({
        role: z.enum(['PREPARE', 'BACKUP', 'LEAF_COPY', 'RECONCILE', 'LEAF_OBSERVE', 'HEALTH']),
        outcome: z.literal('ok'),
        invocationId: z.string().min(1).max(255),
        providerReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        cpuMs: z.number().finite().nonnegative(),
        cpuLimitMs: z.number().finite().positive().max(30000),
        wallMs: z.number().finite().nonnegative().max(900000),
        peakMemoryBytes: z.number().int().positive().max(134217728),
        memoryLimitBytes: z.literal(134217728),
        limitScope: z.enum(['CALLER_CONTEXT', 'WORKER_INVOCATION']),
        limitsReadbackVerified: z.literal(true),
      }),
    )
    .min(6)
    .max(12),
});
export function assessProviderEvidence(
  input: unknown,
): 'NOT_PROVEN' | 'FAIL' | 'ELIGIBLE_FOR_PROVIDER_REVIEW' {
  const parsed = providerSchema.safeParse(input);
  if (!parsed.success) return 'NOT_PROVEN';
  const e = parsed.data;
  if (
    e.verifiedSize !== e.sizeBytes ||
    e.verifiedHash !== e.expectedHash ||
    new Set(e.executions.map((x) => x.role)).size !== 6 ||
    e.executions.some((x) => x.cpuMs > x.cpuLimitMs || x.peakMemoryBytes >= x.memoryLimitBytes)
  )
    return 'FAIL';
  return 'ELIGIBLE_FOR_PROVIDER_REVIEW';
}

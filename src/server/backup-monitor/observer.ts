import { FRESHNESS_MS, validateBackupEvidence, type Decision, type ObjectHead } from './evidence';
/** This interface is a code capability, not IAM proof. A deployed reader must use
 * exact-bucket Object Read credentials. No backup-binding/credential bootstrap here. */
export interface BackupReader {
  list(
    prefix: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ keys: string[]; cursor?: string }>;
  head(key: string, signal?: AbortSignal): Promise<ObjectHead | null>;
  readJSON(key: string, maxBytes: number, signal?: AbortSignal): Promise<unknown>;
}
export function hourPrefixes(now: number, freshnessMs = FRESHNESS_MS): string[] {
  if (
    !Number.isSafeInteger(now) ||
    now < freshnessMs ||
    !Number.isSafeInteger(freshnessMs) ||
    freshnessMs <= 0 ||
    freshnessMs > FRESHNESS_MS
  )
    throw Error('INVALID_CLOCK');
  const out: string[] = [];
  for (let t = Math.floor((now - freshnessMs) / 3600000) * 3600000; t <= now; t += 3600000) {
    const d = new Date(t).toISOString();
    out.push(
      `d1/mayisigorta-crm/${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(11, 13)}/`,
    );
  }
  return out;
}
/** Source metadata only. Fixed T; capped complete pagination, no SQL GET.
 * Non-atomic listing: bounded re-list before negative avoids one normal publication race,
 * but no linearizable snapshot guarantee is claimed. */
async function inspectBackup(
  reader: BackupReader,
  now: number,
  signal: AbortSignal,
  freshnessMs: number,
): Promise<Decision> {
  try {
    const prefixes = hourPrefixes(now, freshnessMs);
    let pages = 0,
      objects = 0,
      generations = 0;
    for (let pass = 0; pass < 2; pass++) {
      const keys = new Set<string>();
      for (const prefix of prefixes) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          if (++pages > 12) throw Error('PAGE_BUDGET');
          if (signal.aborted) throw Error('DEADLINE');
          const page = await reader.list(prefix, cursor, signal);
          if (signal.aborted) throw Error('DEADLINE');
          if (!Array.isArray(page.keys) || (objects += page.keys.length) > 500)
            throw Error('OBJECT_BUDGET');
          for (const key of page.keys) {
            if (typeof key !== 'string' || !key.startsWith(prefix) || key.length > 512)
              throw Error('KEY_SCOPE');
            if (key.endsWith('/COMPLETE.json')) keys.add(key);
          }
          cursor = page.cursor;
          if (cursor !== undefined) {
            if (typeof cursor !== 'string' || !cursor || cursor.length > 2048 || seen.has(cursor))
              throw Error('CURSOR');
            seen.add(cursor);
          }
        } while (cursor !== undefined);
      }
      const decisions: Decision[] = [];
      for (const key of [...keys].sort().reverse()) {
        if (++generations > 6 || signal.aborted) throw Error('GENERATION_BUDGET_OR_DEADLINE');
        const prefix = key.slice(0, -'COMPLETE.json'.length);
        const sql = await reader.head(prefix + 'database.sql', signal),
          mh = await reader.head(prefix + 'manifest.json', signal),
          ch = await reader.head(key, signal);
        if (signal.aborted) throw Error('DEADLINE');
        if (!ch) continue; // marker disappeared/racing listing; never accepted without current exact HEAD
        if (!sql || !mh) throw Error('INCOMPLETE_PUBLISHED_GENERATION');
        const manifest = await reader.readJSON(prefix + 'manifest.json', 8192, signal),
          complete = await reader.readJSON(key, 8192, signal);
        if (signal.aborted) throw Error('DEADLINE');
        const decision = validateBackupEvidence(
          { sql, manifestHead: mh, completeHead: ch, manifest, complete },
          now,
          freshnessMs,
        );
        if (decision.status === 'QUERY_OR_PROVIDER_FAILURE') return decision;
        decisions.push(decision);
      }
      decisions.sort((a, b) => b.exportAt! - a.exportAt!);
      if (decisions.some((d) => d.status === 'HEALTHY'))
        return decisions.find((d) => d.status === 'HEALTHY')!;
      if (pass === 1)
        return (
          decisions[0] ?? {
            status: 'BACKUP_STALE',
            checkedAt: now,
            reason: 'NO_VALID_COMPLETE_IN_FRESHNESS_WINDOW',
          }
        );
    }
    throw Error('UNREACHABLE');
  } catch {
    return {
      status: 'QUERY_OR_PROVIDER_FAILURE',
      checkedAt: now,
      reason: 'READ_DISCOVERY_OR_VALIDATION_FAILED',
    };
  }
}
export async function observeBackup(
  reader: BackupReader,
  now: number,
  freshnessMs = FRESHNESS_MS,
): Promise<Decision> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Decision>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        status: 'QUERY_OR_PROVIDER_FAILURE',
        checkedAt: now,
        reason: 'OBSERVATION_DEADLINE_EXCEEDED',
      });
    }, 20000);
  });
  try {
    return await Promise.race([
      inspectBackup(reader, now, controller.signal, freshnessMs),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

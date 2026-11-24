import { BACKUP_SOURCE, nativeBackupFetch, type BackupEnv } from './core';
import { MAX_GZIP_SQL_BYTES } from './format';

const WARNING_BYTES = 7_000_000_000;
const RETENTION_DAYS = 40;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('R2_CAPACITY_UNAVAILABLE');
  return value as Record<string, unknown>;
}

function bytes(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('R2_CAPACITY_UNAVAILABLE');
  return value;
}

export async function readCapacity(
  env: Pick<BackupEnv, 'CLOUDFLARE_EMAIL' | 'CLOUDFLARE_API_KEY'>,
  newestBackupBytes: number | null,
  request = nativeBackupFetch,
) {
  const response = await request(
    'https://api.cloudflare.com/client/v4/accounts/' + BACKUP_SOURCE.accountId + '/r2/metrics',
    {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { 'X-Auth-Email': env.CLOUDFLARE_EMAIL, 'X-Auth-Key': env.CLOUDFLARE_API_KEY },
    },
  );
  if (!response.ok) throw new Error('R2_CAPACITY_UNAVAILABLE');
  const envelope = record(await response.json());
  if (envelope.success !== true) throw new Error('R2_CAPACITY_UNAVAILABLE');
  const standard = record(record(envelope.result).standard);
  const total = ['published', 'uploaded'].reduce((sum, key) => {
    const group = record(standard[key]);
    return sum + bytes(group.payloadSize) + bytes(group.metadataSize);
  }, 0);
  bytes(total);
  if (
    newestBackupBytes !== null &&
    (!Number.isSafeInteger(newestBackupBytes) ||
      newestBackupBytes < 1 ||
      newestBackupBytes > MAX_GZIP_SQL_BYTES)
  )
    throw new Error('R2_CAPACITY_UNAVAILABLE');
  // Keep all current storage in the upper estimate, even objects due to expire.
  const projectedBytes =
    newestBackupBytes === null ? null : total + RETENTION_DAYS * newestBackupBytes;
  return {
    storedBytes: total,
    projectedBytes,
    warning: total >= WARNING_BYTES || (projectedBytes ?? 0) >= WARNING_BYTES,
  };
}

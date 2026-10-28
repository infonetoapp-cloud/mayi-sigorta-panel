export interface ProviderInventory {
  complete: true;
  objects: Array<{ key: string; size: number; etag: string; last_modified: string }>;
}
/** Canary-only bounded SDK inventory. Never interpret missing pagination as complete. */
export async function readProviderInventory(
  storage: R2Bucket,
  role: 'primary' | 'recovery',
): Promise<ProviderInventory> {
  const result = await storage.list({ limit: 4 });
  if (result.truncated !== false) throw new Error('CANARY_INVENTORY_INCOMPLETE');
  const prefix = role === 'primary' ? 'quarantine/' : 'backup/';
  if (
    result.objects.length > 3 ||
    new Set(result.objects.map((o) => o.key)).size !== result.objects.length ||
    result.objects.some(
      (o) =>
        !o.key.startsWith(prefix) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
          o.key.slice(prefix.length),
        ) ||
        !Number.isSafeInteger(o.size) ||
        o.size < 1 ||
        o.size > 20971520 ||
        typeof o.etag !== 'string' ||
        !o.etag ||
        !(o.uploaded instanceof Date) ||
        !Number.isFinite(o.uploaded.getTime()),
    )
  )
    throw new Error('CANARY_INVENTORY_SHAPE');
  return {
    complete: true,
    objects: result.objects
      .map((o) => ({
        key: o.key,
        size: o.size,
        etag: o.etag,
        last_modified: o.uploaded.toISOString(),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

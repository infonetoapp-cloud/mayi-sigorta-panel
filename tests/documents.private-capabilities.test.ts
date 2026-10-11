// @vitest-environment node
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { composePrivateDocumentCapabilities } from '../src/server/documents/private-capabilities';
import { documentBackupObjectKey } from '../src/server/documents/backup-storage';
import type { DocumentBackupCapability } from '../src/server/documents/backup-capability-contract';
const bytes = new TextEncoder().encode('synthetic-only');
const identity = {
  agencyId: 'synthetic-agency',
  documentVersionId: 'synthetic-version',
  generation: 1,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  sizeBytes: bytes.byteLength,
};
const primary = { get: async () => null } as unknown as R2Bucket;
function peer(overrides: Partial<DocumentBackupCapability> = {}): DocumentBackupCapability {
  return {
    createAndVerify: async () => ({
      ok: true,
      value: { ...identity, objectKey: documentBackupObjectKey(identity) },
    }),
    observeBackup: async () => ({ ok: true, value: null }),
    ...overrides,
  };
}
it('composition exports only frozen narrow capabilities, no bucket/http/destructive methods', () => {
  const p = composePrivateDocumentCapabilities(primary, peer())!;
  expect(Object.keys(p.source)).toEqual(['get']);
  expect(Object.keys(p.backup)).toEqual(['createAndVerify']);
  expect(Object.keys(p.reconcile).sort()).toEqual(['observe', 'primary', 'verifyBackup']);
  expect(
    Object.isFrozen(p) &&
      Object.isFrozen(p.backup) &&
      Object.isFrozen(p.reconcile) &&
      Object.isFrozen(p.source),
  ).toBe(true);
  expect(composePrivateDocumentCapabilities(primary, undefined)).toBeUndefined();
  expect(composePrivateDocumentCapabilities(undefined, peer())).toBeUndefined();
});
it('does not bind RPC references, and captures methods/identity/bytes before await', async () => {
  let release!: (value: unknown) => void,
    calls = 0;
  const captured: unknown[] = [];
  const pending = new Promise<unknown>((r) => {
    release = r;
  });
  const method = async (i: unknown, b: unknown) => {
    calls++;
    captured.push(i, b);
    return pending;
  };
  Object.defineProperty(method, 'bind', {
    get() {
      throw new Error('RPC_BIND_IS_NOT_LOCAL_FUNCTION_BIND');
    },
  });
  const binding = peer({ createAndVerify: method as DocumentBackupCapability['createAndVerify'] });
  const composed = composePrivateDocumentCapabilities(primary, binding)!;
  const input = { ...identity },
    data = bytes.slice();
  const promise = composed.backup.createAndVerify(input, data, new AbortController().signal);
  input.generation = 2;
  data[0] = 0;
  binding.createAndVerify = async () => {
    throw new Error('NEW_ALIAS_MUST_NOT_RUN');
  };
  release({ ok: true, value: { ...identity, objectKey: documentBackupObjectKey(identity) } });
  await promise;
  expect(calls).toBe(1);
  expect((captured[0] as typeof identity).generation).toBe(1);
  expect(
    createHash('sha256')
      .update(new Uint8Array(await new Response(captured[1] as ReadableStream).arrayBuffer()))
      .digest('hex') === identity.sha256,
  ).toBe(true);
});
it('rejects malformed/extra/mismatched proof before caller can finalize a backup', async () => {
  for (const value of [
    { ...identity, objectKey: 'backup/00000000-0000-0000-0000-000000000000' },
    { ...identity, generation: 2, objectKey: documentBackupObjectKey(identity) },
    { ...identity, objectKey: documentBackupObjectKey(identity), unexpected: 'forbidden' },
  ]) {
    const p = composePrivateDocumentCapabilities(
      primary,
      peer({ createAndVerify: async () => ({ ok: true, value }) }),
    )!;
    await expect(
      p.backup.createAndVerify(identity, bytes, new AbortController().signal),
    ).rejects.toThrow('BACKUP_PROOF_MISMATCH');
  }
});
it('sanitizes RPC exceptions and converts typed integrity results into local integrity errors', async () => {
  const p = composePrivateDocumentCapabilities(
    primary,
    peer({
      createAndVerify: async () => {
        throw new Error('synthetic-private-provider-text');
      },
    }),
  )!;
  const error = await p.backup.createAndVerify(identity, bytes, new AbortController().signal).then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(error?.message).toBe('DOCUMENT_BACKUP_CAPABILITY_IO');
  expect(error?.cause).toBeUndefined();
  expect(error?.stack?.includes('synthetic-private-provider-text')).toBe(false);
  const integrity = composePrivateDocumentCapabilities(
    primary,
    peer({ createAndVerify: async () => ({ ok: false, kind: 'INTEGRITY' }) }),
  )!;
  await expect(
    integrity.backup.createAndVerify(identity, bytes, new AbortController().signal),
  ).rejects.toThrow('BACKUP_PROOF_MISMATCH');
});
it('reconcile cannot call create/write and refuses wrong-key/prefix before any RPC', async () => {
  let writes = 0,
    reads = 0;
  const p = composePrivateDocumentCapabilities(
    primary,
    peer({
      createAndVerify: async () => {
        writes++;
        throw new Error('FORBIDDEN');
      },
      observeBackup: async () => {
        reads++;
        return { ok: true, value: null };
      },
    }),
  )!;
  expect(
    await p.reconcile.verifyBackup(
      identity,
      documentBackupObjectKey(identity),
      new AbortController().signal,
    ),
  ).toBeNull();
  expect(reads).toBe(1);
  expect(writes).toBe(0);
  await expect(
    p.reconcile.verifyBackup(
      identity,
      'backup/00000000-0000-0000-0000-000000000000',
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  await expect(
    p.reconcile.observe('BACKUP', 'd1/forbidden/database.sql', new AbortController().signal),
  ).rejects.toThrow();
  expect(reads).toBe(1);
});
it('already-aborted operations invoke no private RPC', async () => {
  let calls = 0;
  const p = composePrivateDocumentCapabilities(
    primary,
    peer({
      createAndVerify: async () => {
        calls++;
        throw new Error('UNEXPECTED');
      },
    }),
  )!;
  const controller = new AbortController();
  controller.abort();
  await expect(p.backup.createAndVerify(identity, bytes, controller.signal)).rejects.toThrow();
  expect(calls).toBe(0);
});

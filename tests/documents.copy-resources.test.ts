// @vitest-environment node
import { expect, it } from 'vitest';
import {
  readBoundedDocumentStream,
  documentByteStream,
} from '../src/server/documents/copy-resources';
import {
  createR2DocumentBackupAdapter,
  documentBackupObjectKey,
} from '../src/server/documents/backup-storage';
import { createHash } from 'node:crypto';
const sum = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
it('closed permit rejects new source/RPC provider work without invoking any late factory', async () => {
  const { createDocumentAdmission, trackedDocumentBucket } =
      await import('../src/server/documents/resource-admission'),
    { composePrivateDocumentCapabilities } =
      await import('../src/server/documents/private-capabilities');
  const permit = createDocumentAdmission().acquire()!;
  let reads = 0,
    copies = 0;
  const storage = trackedDocumentBucket(
      {
        get: async () => {
          reads++;
          return null;
        },
      } as unknown as R2Bucket,
      permit,
    ),
    peer = {
      createAndVerify: async () => {
        copies++;
        return { ok: false, kind: 'IO' };
      },
      observeBackup: async () => ({ ok: true, value: null }),
    } as never;
  const client = composePrivateDocumentCapabilities(storage as R2Bucket, peer, permit)!;
  permit.release();
  await expect(storage.get('synthetic')).rejects.toThrow();
  const bytes = new Uint8Array([1]),
    id = {
      agencyId: 'synthetic',
      documentVersionId: 'synthetic',
      generation: 1,
      sizeBytes: 1,
      sha256: sum(bytes),
    };
  await expect(
    client.backup.createAndVerify(id, bytes, new AbortController().signal),
  ).rejects.toThrow();
  expect([reads, copies]).toEqual([0, 0]);
});
it('closed old D1 continuation cannot start a late batch after admission reopens', async () => {
  const { createDocumentAdmission, trackedDocumentDatabase } =
    await import('../src/server/documents/resource-admission');
  const gate = createDocumentAdmission(),
    old = gate.acquire()!;
  let settle!: (value: null) => void,
    batches = 0;
  const first = new Promise<null>((r) => {
    settle = r;
  });
  const statement = {
    first: () => first,
    bind() {
      return this;
    },
  };
  const db = trackedDocumentDatabase(
    {
      prepare: () => statement,
      batch: async () => {
        batches++;
        return [];
      },
    } as unknown as D1Database,
    old,
  );
  const abandoned = (async () => {
    await db.prepare('synthetic').first();
    await db.batch([]);
  })().catch(() => null);
  old.release();
  expect(gate.acquire()).toBeNull();
  settle(null);
  await abandoned;
  expect(batches).toBe(0);
  const live = gate.acquire();
  expect(live !== null).toBe(true);
  live!.release();
});
it('sender abort closes owned producer without waiting for another remote pull', async () => {
  const controller = new AbortController(),
    reader = documentByteStream(new Uint8Array(1048576), controller.signal).getReader();
  await reader.read();
  let closed = false;
  void reader.closed.catch(() => {
    closed = true;
  });
  controller.abort();
  await new Promise((r) => setTimeout(r, 5));
  expect(closed).toBe(true);
  reader.releaseLock();
});
it('sender produces demand-driven64KiB independent backing stores without whole-file chunk arrays', async () => {
  const reader = documentByteStream(
    new Uint8Array(1048576),
    new AbortController().signal,
  ).getReader();
  let n = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      expect(r.value.byteLength <= 65536 && r.value.buffer.byteLength <= 65536).toBe(true);
      n += r.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  expect(n).toBe(1048576);
});
it('late source get keeps admission quarantined through cancellation completion', async () => {
  const { createDocumentAdmission, trackedDocumentBucket } =
    await import('../src/server/documents/resource-admission');
  const gate = createDocumentAdmission(),
    permit = gate.acquire()!;
  let resolveGet!: (value: R2ObjectBody) => void, resolveCancel!: () => void;
  const cancel = new Promise<void>((r) => {
      resolveCancel = r;
    }),
    get = new Promise<R2ObjectBody>((r) => {
      resolveGet = r;
    });
  const storage = trackedDocumentBucket({ get: () => get } as unknown as R2Bucket, permit);
  const work = storage.get('synthetic-key').catch(() => null);
  permit.release();
  resolveGet({
    body: new ReadableStream({
      cancel() {
        return cancel;
      },
    }),
  } as R2ObjectBody);
  await Promise.resolve();
  await Promise.resolve();
  expect(gate.acquire()).toBeNull();
  resolveCancel();
  await work;
  await Promise.resolve();
  expect(gate.acquire() !== null).toBe(true);
});
it('actual stream20MiB+1 cannot fit declared20MiB or produce verified data', async () => {
  const data = new Uint8Array(20971521),
    signal = new AbortController().signal;
  await expect(
    readBoundedDocumentStream(
      documentByteStream(data, signal),
      20971520,
      sum(data.subarray(0, 20971520)),
      signal,
    ),
  ).rejects.toThrow('BACKUP_LENGTH_MISMATCH');
});
it('destination timeout does not return proof or release raw pending-write admission', async () => {
  const { createDocumentAdmission } = await import('../src/server/documents/resource-admission');
  const gate = createDocumentAdmission(),
    permit = gate.acquire()!;
  let settle!: (value: null) => void;
  const pending = new Promise<null>((r) => {
    settle = r;
  });
  let reads = 0;
  const data = new Uint8Array([1]),
    id = {
      agencyId: 'synthetic',
      documentVersionId: 'synthetic',
      generation: 1,
      sizeBytes: 1,
      sha256: sum(data),
    },
    controller = new AbortController();
  const storage = {
    put: () => permit.track(pending),
    get: async () => {
      reads++;
      return null;
    },
  } as unknown as R2Bucket;
  const work = createR2DocumentBackupAdapter(storage).createAndVerify(id, data, controller.signal);
  controller.abort();
  await expect(work).rejects.toThrow();
  permit.release();
  expect(reads).toBe(0);
  expect(gate.acquire()).toBeNull();
  settle(null);
  await pending;
  await Promise.resolve();
  expect(gate.acquire() !== null).toBe(true);
});
it.each([1, 4096, 1048576, 20971519, 20971520])(
  'bounded reader accepts %s bytes with exact checksum',
  async (size) => {
    const bytes = new Uint8Array(size);
    bytes.fill(19);
    const signal = new AbortController().signal;
    const read = await readBoundedDocumentStream(
      documentByteStream(bytes, signal),
      size,
      sum(bytes),
      signal,
    );
    expect(read.byteLength === size && sum(read) === sum(bytes)).toBe(true);
  },
);
it.each(['oversize', 'grow', 'shrink', 'checksum', 'missing-size', 'bad-metadata'] as const)(
  'reader rejects %s, cancels input and does not produce verified data',
  async (kind) => {
    let cancelled = 0;
    const bytes = new Uint8Array(kind === 'grow' ? 2 : 1);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        if (kind !== 'grow') c.close();
      },
      cancel() {
        cancelled++;
      },
    });
    const size =
        kind === 'oversize' ? 20971521 : kind === 'missing-size' ? NaN : kind === 'shrink' ? 2 : 1,
      sha = kind === 'bad-metadata' ? 'invalid' : kind === 'checksum' ? '0'.repeat(64) : sum(bytes);
    await expect(
      readBoundedDocumentStream(stream, size, sha, new AbortController().signal),
    ).rejects.toThrow();
    if (kind === 'grow') expect(cancelled).toBe(1);
  },
);
it('stalled reader abort is bounded, cancellation is best-effort and late task never verifies', async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => undefined);
    },
    cancel() {
      cancelled++;
    },
  });
  const controller = new AbortController();
  const work = readBoundedDocumentStream(stream, 1, sum(new Uint8Array(1)), controller.signal);
  controller.abort();
  await expect(work).rejects.toThrow();
  expect(cancelled).toBe(1);
});
it('destination size/hash mismatch and failed write never return backup proof', async () => {
  const data = new Uint8Array([1]);
  const identity = {
    agencyId: 'synthetic',
    documentVersionId: 'synthetic',
    generation: 1,
    sizeBytes: 1,
    sha256: sum(data),
  };
  for (const kind of ['size', 'hash', 'write']) {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([2]));
        c.close();
      },
    });
    const storage = {
      put: async () => {
        if (kind === 'write') throw new Error('SYNTHETIC_IO');
        return null;
      },
      get: async () => ({
        size: kind === 'size' ? 2 : 1,
        customMetadata: {
          agencyId: identity.agencyId,
          documentVersionId: identity.documentVersionId,
          generation: '1',
          sha256: identity.sha256,
        },
        body,
      }),
    } as unknown as R2Bucket;
    await expect(
      createR2DocumentBackupAdapter(storage).createAndVerify(
        identity,
        data,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
  expect(documentBackupObjectKey(identity).startsWith('backup/')).toBe(true);
});
it('RPC abort cannot refill admission while raw remote promise survives', async () => {
  const { createDocumentAdmission } = await import('../src/server/documents/resource-admission'),
    { composePrivateDocumentCapabilities } =
      await import('../src/server/documents/private-capabilities');
  const gate = createDocumentAdmission(),
    permit = gate.acquire()!;
  let settle!: (r: unknown) => void;
  const remote = new Promise<unknown>((r) => {
    settle = r;
  });
  const capability = {
    createAndVerify: () => remote,
    observeBackup: async () => ({ ok: true, value: null }),
  } as never;
  const primary = { get: async () => null } as unknown as R2Bucket;
  const client = composePrivateDocumentCapabilities(primary, capability, permit)!;
  const data = new Uint8Array([1]);
  const id = {
    agencyId: 'synthetic',
    documentVersionId: 'synthetic',
    generation: 1,
    sizeBytes: 1,
    sha256: sum(data),
  };
  const controller = new AbortController();
  const call = client.backup.createAndVerify(id, data, controller.signal);
  controller.abort();
  await expect(call).rejects.toThrow();
  permit.release();
  expect(gate.acquire()).toBeNull();
  settle({ ok: false, kind: 'IO' });
  await remote;
  await Promise.resolve();
  expect(gate.acquire() !== null).toBe(true);
});
it('wire stream uses bounded chunks and exact hard-size/hash verification without tee', async () => {
  const mod = await import('../src/server/documents/copy-resources').catch(() => null);
  expect(mod).not.toBeNull();
  const bytes = new Uint8Array(1024 * 1024);
  bytes.fill(7);
  const controller = new AbortController();
  const stream = mod!.documentByteStream(bytes, controller.signal);
  const actual = await mod!.readBoundedDocumentStream(
    stream,
    bytes.byteLength,
    createHash('sha256').update(bytes).digest('hex'),
    controller.signal,
  );
  expect(actual.byteLength).toBe(bytes.byteLength);
  expect(actual.every((v) => v === 7)).toBe(true);
});
it('Queue schema accepts references only and rejects extra body/base64/oversized metadata', async () => {
  const mod = await import('../src/server/documents/queue-message').catch(() => null);
  expect(mod).not.toBeNull();
  const good = {
    jobId: 'synthetic-job',
    jobType: 'DOCUMENT_BACKUP',
    generation: 1,
    documentVersionId: 'synthetic-version',
    inputSha256: 'a'.repeat(64),
  };
  expect(mod!.parseDocumentQueueControl(good) !== null).toBe(true);
  for (const input of [
    { ...good, bytes: new Uint8Array(1) },
    { ...good, base64: 'a'.repeat(100000) },
    { ...good, metadata: {} },
    { ...good, jobId: 'a'.repeat(256) },
    { ...good, generation: Infinity },
    null,
  ])
    expect(mod!.parseDocumentQueueControl(input)).toBeNull();
});
it('released permit cannot clear a newer live permit', async () => {
  const { createDocumentAdmission } = await import('../src/server/documents/resource-admission');
  const gate = createDocumentAdmission(),
    first = gate.acquire()!;
  first.release();
  const second = gate.acquire()!;
  first.release();
  expect(gate.acquire()).toBeNull();
  second.release();
});
it('one non-waiting admission remains held until timed-out underlying operation settles', async () => {
  const mod = await import('../src/server/documents/resource-admission').catch(() => null);
  expect(mod).not.toBeNull();
  const gate = mod!.createDocumentAdmission();
  const permit = gate.acquire();
  expect(permit !== null).toBe(true);
  expect(gate.acquire()).toBeNull();
  let settle!: () => void;
  const pending = new Promise<void>((r) => {
    settle = r;
  });
  permit!.track(pending);
  permit!.release();
  expect(gate.acquire()).toBeNull();
  settle();
  await pending;
  await Promise.resolve();
  const next = gate.acquire();
  expect(next !== null).toBe(true);
  next!.release();
});

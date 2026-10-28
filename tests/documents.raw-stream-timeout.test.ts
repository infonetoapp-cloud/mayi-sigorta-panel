import { afterEach, expect, it, vi } from 'vitest';
import { writeRawQuarantine, RawQuarantineError } from '../src/server/documents/raw-stream';
afterEach(() => {
  vi.unstubAllGlobals();
});
it('rejects an already locked request body before starting provider work', async () => {
  vi.stubGlobal(
    'FixedLengthStream',
    class {
      readable: ReadableStream;
      writable: WritableStream;
      constructor() {
        const stream = new TransformStream();
        this.readable = stream.readable;
        this.writable = stream.writable;
      }
    },
  );
  const bytes = new Uint8Array([1, 2, 3]);
  const checksum = await crypto.subtle.digest('SHA-256', bytes);
  const sha = Array.from(new Uint8Array(checksum), (b) => b.toString(16).padStart(2, '0')).join('');
  const request = new Request('https://synthetic.invalid', { method: 'POST', body: bytes });
  const reader = request.body!.getReader();
  const put = vi.fn(async () => ({ size: 3, checksums: { sha256: checksum } }));
  try {
    await expect(
      writeRawQuarantine(request, { put } as unknown as R2Bucket, {
        objectKey: 'quarantine/11111111-1111-4111-8111-111111111111',
        sizeBytes: 3,
        expectedSha256: sha,
        fileName: 'test.png',
        contentType: 'image/png',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(put).not.toHaveBeenCalled();
  } finally {
    reader.releaseLock();
  }
});
it('rejects a slow stream and aborts both native upload sides without trusting availability', async () => {
  vi.useFakeTimers();
  let stopped = false;
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      stopped = true;
    },
  });
  const put = vi.fn(async (_key: string, body: ReadableStream) => {
    await new Response(body).arrayBuffer();
    return null;
  });
  vi.stubGlobal(
    'FixedLengthStream',
    class {
      readable: ReadableStream;
      writable: WritableStream;
      constructor() {
        const t = new TransformStream();
        this.readable = t.readable;
        this.writable = t.writable;
      }
    },
  );
  const request = new Request('https://synthetic.invalid', {
    method: 'POST',
    body: source,
    duplex: 'half',
  } as RequestInit);
  const promise = writeRawQuarantine(request, { put } as unknown as R2Bucket, {
    objectKey: 'quarantine/11111111-1111-4111-8111-111111111111',
    sizeBytes: 3,
    expectedSha256: '0'.repeat(64),
    fileName: 'test.png',
    contentType: 'image/png',
  });
  const assertion = expect(promise).rejects.toBeInstanceOf(RawQuarantineError);
  try {
    await vi.advanceTimersByTimeAsync(30001);
    await assertion;
    expect(stopped).toBe(true);
  } finally {
    vi.useRealTimers();
  }
}, 1000);
it('detaches the original transport identity before awaiting provider work', async () => {
  vi.stubGlobal(
    'FixedLengthStream',
    class {
      readable: ReadableStream;
      writable: WritableStream;
      constructor() {
        const stream = new TransformStream();
        this.readable = stream.readable;
        this.writable = stream.writable;
      }
    },
  );
  const bytes = new Uint8Array([1, 2, 3]);
  const checksum = await crypto.subtle.digest('SHA-256', bytes);
  const expected = Array.from(new Uint8Array(checksum), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const input = {
    objectKey: 'quarantine/11111111-1111-4111-8111-111111111111',
    sizeBytes: 3,
    expectedSha256: expected,
    fileName: 'test.png',
    contentType: 'image/png' as const,
  };
  const put = vi.fn(async (_key: string, body: ReadableStream) => {
    await new Response(body).arrayBuffer();
    input.sizeBytes = 1;
    input.expectedSha256 = '0'.repeat(64);
    return { size: 3, checksums: { sha256: checksum } };
  });
  const result = await writeRawQuarantine(
    new Request('https://synthetic.invalid', { method: 'POST', body: bytes }),
    { put } as unknown as R2Bucket,
    input,
  );
  expect(result.sizeBytes).toBe(3);
  expect(result.expectedSha256 === expected).toBe(true);
});
it('does not replenish bounded admission while timed-out provider writes survive', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'FixedLengthStream',
    class {
      readable: ReadableStream;
      writable: WritableStream;
      constructor() {
        const stream = new TransformStream();
        this.readable = stream.readable;
        this.writable = stream.writable;
      }
    },
  );
  const bytes = new Uint8Array([1, 2, 3]);
  const checksum = await crypto.subtle.digest('SHA-256', bytes);
  const sha = Array.from(new Uint8Array(checksum), (b) => b.toString(16).padStart(2, '0')).join('');
  const pending: (() => void)[] = [];
  const put = vi.fn(async (_key: string, body: ReadableStream) => {
    await new Response(body).arrayBuffer();
    await new Promise<void>((resolve) => pending.push(resolve));
    return { size: 3, checksums: { sha256: checksum } };
  });
  const start = () =>
    writeRawQuarantine(
      new Request('https://synthetic.invalid', { method: 'POST', body: bytes }),
      { put } as unknown as R2Bucket,
      {
        objectKey: 'quarantine/11111111-1111-4111-8111-111111111111',
        sizeBytes: 3,
        expectedSha256: sha,
        fileName: 'test.png',
        contentType: 'image/png',
      },
    );
  const requests: Promise<unknown>[] = [];
  try {
    requests.push(
      start().catch((error) => error),
      start().catch((error) => error),
    );
    await vi.advanceTimersByTimeAsync(30001);
    expect(await requests[0]).toBeInstanceOf(RawQuarantineError);
    expect(await requests[1]).toBeInstanceOf(RawQuarantineError);
    requests.push(start().catch((error) => error));
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(2);
    expect(await requests[2]).toBeInstanceOf(RawQuarantineError);
  } finally {
    for (const settle of pending) settle();
    await vi.advanceTimersByTimeAsync(30001);
    await Promise.all(requests);
    vi.useRealTimers();
  }
}, 2000);

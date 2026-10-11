export interface CanaryMetrics {
  r2Get: number;
  r2Put: number;
  readBytes: number;
  writtenBytes: number;
  d1Calls: number;
  d1Statements: number;
  rpcChunks: number;
  rpcBytes: number;
  stageMs: Record<string, number>;
}
export function metrics(): CanaryMetrics {
  return {
    r2Get: 0,
    r2Put: 0,
    readBytes: 0,
    writtenBytes: 0,
    d1Calls: 0,
    d1Statements: 0,
    rpcChunks: 0,
    rpcBytes: 0,
    stageMs: {},
  };
}
export function countedStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (n: number) => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream(
    {
      async pull(c) {
        try {
          const r = await reader.read();
          if (r.done) {
            c.close();
            reader.releaseLock();
          } else {
            onChunk(r.value.byteLength);
            c.enqueue(r.value);
          }
        } catch {
          c.error(new Error('CANARY_STREAM_IO'));
          try {
            reader.releaseLock();
          } catch {
            /* closed */
          }
        }
      },
      async cancel() {
        try {
          await reader.cancel();
        } finally {
          try {
            reader.releaseLock();
          } catch {
            /* closed */
          }
        }
      },
    },
    { highWaterMark: 0 },
  );
}
export function countBucket(bucket: R2Bucket, m: CanaryMetrics): R2Bucket {
  return {
    get: async (...args: Parameters<R2Bucket['get']>) => {
      m.r2Get++;
      const start = Date.now(),
        o = await bucket.get(...args);
      m.stageMs.r2Get = (m.stageMs.r2Get ?? 0) + Date.now() - start;
      if (!o) return null;
      return {
        size: o.size,
        customMetadata: o.customMetadata,
        body: countedStream(o.body, (n) => {
          m.readBytes += n;
        }),
      } as R2ObjectBody;
    },
    put: async (...args: Parameters<R2Bucket['put']>) => {
      m.r2Put++;
      const start = Date.now(),
        o = await bucket.put(...args);
      m.stageMs.r2Put = (m.stageMs.r2Put ?? 0) + Date.now() - start;
      const b = args[1];
      if (o && b instanceof Uint8Array) m.writtenBytes += b.byteLength;
      return o;
    },
  } as R2Bucket;
}
export function countDatabase(
  db: D1Database,
  m: CanaryMetrics,
  enabled: () => boolean = () => true,
): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(s, {
      get(target, key) {
        const f = Reflect.get(target, key, target) as unknown;
        if (key === 'bind') return (...a: unknown[]) => wrap(target.bind(...a));
        if (['first', 'all', 'raw', 'run'].includes(String(key)) && typeof f === 'function')
          return async (...a: unknown[]) => {
            if (!enabled()) return await Reflect.apply(f, target, a);
            m.d1Calls++;
            m.d1Statements++;
            const start = Date.now();
            try {
              return await Reflect.apply(f, target, a);
            } finally {
              m.stageMs.d1 = (m.stageMs.d1 ?? 0) + Date.now() - start;
            }
          };
        return typeof f === 'function' ? f.bind(target) : f;
      },
    });
    originals.set(proxy, s);
    return proxy;
  };
  return {
    prepare: (s: string) => wrap(db.prepare(s)),
    batch: async <T>(s: D1PreparedStatement[]) => {
      if (!enabled()) return await db.batch<T>(s.map((x) => originals.get(x) ?? x));
      m.d1Calls++;
      m.d1Statements += s.length;
      const start = Date.now();
      try {
        return await db.batch<T>(s.map((x) => originals.get(x) ?? x));
      } finally {
        m.stageMs.d1 = (m.stageMs.d1 ?? 0) + Date.now() - start;
      }
    },
  } as D1Database;
}

export interface DocumentPermit {
  track<T>(promise: Promise<T>): Promise<T>;
  run<T>(start: () => Promise<T>): Promise<T>;
  release(): void;
  closed(): boolean;
}
/** Per-isolate, no waiting queue and no distributed lock. D1 remains authority.
 * Timeouts cannot replenish a permit while uncancellable provider work survives. */
export function createDocumentAdmission() {
  let occupied: symbol | null = null;
  return Object.freeze({
    acquire(): DocumentPermit | null {
      if (occupied) return null;
      const token = Symbol();
      occupied = token;
      let finished = false,
        pending = 0;
      const check = () => {
        if (finished && pending === 0 && occupied === token) occupied = null;
      };
      return Object.freeze({
        closed: () => finished,
        run<T>(start: () => Promise<T>): Promise<T> {
          if (finished) return Promise.reject(new Error('DOCUMENT_ADMISSION_CLOSED'));
          try {
            return this.track(start());
          } catch {
            return Promise.reject(new Error('DOCUMENT_PROVIDER_IO'));
          }
        },
        track<T>(p: Promise<T>): Promise<T> {
          pending++;
          void p.then(
            () => {
              pending--;
              check();
            },
            () => {
              pending--;
              check();
            },
          );
          return p;
        },
        release() {
          if (finished) return;
          finished = true;
          check();
        },
      });
    },
  });
}
/** Track raw provider calls, not only the abort-raced promises. */
export function trackedDocumentBucket(
  storage: Pick<R2Bucket, 'get'>,
  permit: DocumentPermit,
): Pick<R2Bucket, 'get'> {
  const get = storage.get.bind(storage);
  return {
    get(key: string) {
      return permit.run(async () => {
        const object = await get(key);
        if (!object) return null;
        // A late get after logical timeout must finish its cancellation before
        // admission reopens. If cancellation never settles, remain quarantined.
        if (permit.closed()) {
          await object.body.cancel();
          throw new Error('DOCUMENT_SOURCE_CLOSED');
        }
        const reader = object.body.getReader();
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            reader.releaseLock();
          }
        };
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                const r = await permit.run(() => reader.read());
                if (r.done) {
                  controller.close();
                  release();
                } else controller.enqueue(r.value);
              } catch {
                controller.error(new Error('DOCUMENT_SOURCE_IO'));
                release();
              }
            },
            async cancel() {
              try {
                await permit.track(reader.cancel());
              } finally {
                release();
              }
            },
          },
          { highWaterMark: 0 },
        );
        // These are exactly the readSource/observation fields; no raw object capability.
        return { size: object.size, customMetadata: object.customMetadata, body } as R2ObjectBody;
      });
    },
  } as Pick<R2Bucket, 'get'>;
}
export function trackedDocumentDatabase(db: D1Database, permit: DocumentPermit): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, key) {
        const v = Reflect.get(target, key, target) as unknown;
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (['first', 'all', 'run', 'raw'].includes(String(key)) && typeof v === 'function')
          return (...args: unknown[]) =>
            permit.run(() => Reflect.apply(v, target, args) as Promise<unknown>);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    originals.set(proxy, stmt);
    return proxy;
  };
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: <T>(s: D1PreparedStatement[]) =>
      permit.run(() => db.batch<T>(s.map((p) => originals.get(p) ?? p))),
  } as D1Database;
}

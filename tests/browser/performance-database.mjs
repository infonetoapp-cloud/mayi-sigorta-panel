// Local profiling only: no bindings, SQL values, credentials or row contents retained.
import { performance } from 'node:perf_hooks';
export function profileDatabase(db, samples) {
  const timed = async (kind, sql, run) => {
    const start = performance.now();
    const result = await run();
    const rows = Array.isArray(result) ? result : [result];
    samples.push({
      kind,
      sql: sql.replace(/\s+/g, ' ').trim(),
      wall: performance.now() - start,
      engine: rows.reduce((n, r) => n + (r?.meta?.duration ?? 0), 0),
    });
    return result;
  };
  const wrap = (stmt, sql) =>
    new Proxy(stmt, {
      get(target, key) {
        if (key === 'bind') return (...args) => wrap(target.bind(...args), sql);
        if (['all', 'first', 'run', 'raw'].includes(key))
          return (...args) => timed(key, sql, () => target[key](...args));
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const originals = new WeakMap();
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql) => {
          const stmt = target.prepare(sql);
          const proxy = wrap(stmt, sql);
          originals.set(proxy, stmt);
          return proxy;
        };
      if (key === 'batch')
        return (statements) =>
          timed('batch', 'BATCH ' + statements.length, () =>
            target.batch(statements.map((s) => originals.get(s) ?? s)),
          );
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

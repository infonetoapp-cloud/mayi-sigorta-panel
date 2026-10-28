// Test-only barrier immediately before the final native D1 disclosure (all or batch).
export function interceptFinalRead(
  db: D1Database,
  matches: (sql: string) => boolean,
  before: () => Promise<void>,
) {
  const targets = new WeakMap<object, D1PreparedStatement>();
  let triggered = false;
  async function effect() {
    if (triggered) return;
    triggered = true;
    await before();
  }
  function track(statement: D1PreparedStatement): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => track(target.bind(...values));
        if (key === 'all')
          return async <T>() => {
            await effect();
            return target.all<T>();
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    targets.set(proxy, statement);
    return proxy;
  }
  const guarded = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return matches(sql) ? track(statement) : statement;
    },
    async batch<T>(statements: D1PreparedStatement[]) {
      if (statements.some((statement) => targets.has(statement))) await effect();
      return db.batch<T>(statements.map((statement) => targets.get(statement) ?? statement));
    },
  } as D1Database;
  return { db: guarded, wasTriggered: () => triggered };
}

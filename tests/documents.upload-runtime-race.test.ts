// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createUploadRuntime } from '../src/server/documents/upload-runtime';
import { createApp, type Env } from '../src/server/index';
import { createSyntheticPng } from './fixtures/documents';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
const app = createApp(),
  origin = 'https://panel.mayisigorta.com';
beforeAll(async () => {
  f = await localAuthFixture();
}, 60000);
afterAll(async () => {
  await f?.mf.dispose();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup() {
  const actor = await f.seed(crypto.randomUUID(), 'OWNER');
  const customer = crypto.randomUUID(),
    key = crypto.randomUUID();
  await f.db
    .prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES(?,?,'INDIVIDUAL','Synthetic','Synthetic','Only',?)",
    )
    .bind(customer, actor.agencyId, actor.membershipId)
    .run();
  const session = await f.session(actor.id);
  async function credentials(cookie: string) {
    const response = await app.fetch(
      new Request(origin + '/api/csrf-token', { headers: { Cookie: cookie } }),
      f.env,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: { token: string } }).data.token;
  }
  function request(cookie: string, csrf: string) {
    const form = new FormData();
    form.set('ownerType', 'CUSTOMER');
    form.set('ownerId', customer);
    form.set('classification', 'GENERAL');
    form.set('file', new File([createSyntheticPng(1, 1)], 'synthetic.png', { type: 'image/png' }));
    return new Request(origin + '/api/documents', {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Idempotency-Key': key },
      body: form,
    });
  }
  const env: Env = {
    ...f.env,
    DOCUMENTS_ENABLED: 'true',
    DOCUMENT_UPLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) },
    DOCS_QUARANTINE: { put: async () => ({}) as R2Object } as unknown as R2Bucket,
  };
  return { actor, key, session, credentials, request, env };
}
function pausedFinalBatch(mode: 'BEFORE' | 'AFTER') {
  const entered = deferred(),
    release = deferred();
  const originals = new WeakMap<object, { statement: D1PreparedStatement; sql: string }>();
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, { statement, sql });
    return wrapped;
  }
  let paused = false;
  const db = {
    prepare: (sql: string) => wrap(f.db.prepare(sql), sql),
    async batch<T>(statements: D1PreparedStatement[]) {
      const raw = statements.map((statement) => originals.get(statement)?.statement ?? statement);
      const final =
        !paused &&
        statements.some((statement) =>
          originals
            .get(statement)
            ?.sql.includes("UPDATE operation_receipts SET status='COMPLETED'"),
        );
      if (!final) return f.db.batch<T>(raw);
      paused = true;
      if (mode === 'BEFORE') {
        entered.resolve();
        await release.promise;
        return f.db.batch<T>(raw);
      }
      const result = await f.db.batch<T>(raw);
      entered.resolve();
      await release.promise;
      return result;
    },
  } as D1Database;
  return { db, entered, release };
}
function captureDeadline() {
  const original = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 60000 && typeof handler === 'function' && !expire)
      expire = () => handler(...args);
    return original(handler, delay, ...args);
  }) as typeof setTimeout);
  return {
    expire() {
      expect(typeof expire).toBe('function');
      expire!();
    },
    restore() {
      spy.mockRestore();
    },
  };
}
for (const mode of ['BEFORE', 'AFTER'] as const) {
  it(`keeps native D1 atomic authority and exact retry when deadline/revocation races ${mode} final commit`, async () => {
    const value = await setup(),
      gate = pausedFinalBatch(mode),
      settled = deferred();
    const runtime = createUploadRuntime(async (request, env) => {
      try {
        return await app.fetch(request, env);
      } finally {
        settled.resolve();
      }
    });
    const csrf = await value.credentials(value.session.cookie),
      clock = captureDeadline();
    const pending = runtime.fetch(value.request(value.session.cookie, csrf), {
      ...value.env,
      DB: gate.db,
    });
    try {
      await gate.entered.promise;
      await f.db
        .prepare(
          "UPDATE local_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND revoked_at IS NULL",
        )
        .bind(value.actor.id)
        .run();
      clock.expire();
      expect((await pending).status).toBe(503);
      expect(
        (await runtime.fetch(value.request(value.session.cookie, csrf), value.env)).status,
      ).toBe(503);
    } finally {
      gate.release.resolve();
      await settled.promise;
      clock.restore();
    }
    await Promise.resolve();
    await Promise.resolve();
    expect((await runtime.fetch(value.request(value.session.cookie, csrf), value.env)).status).toBe(
      401,
    );
    const receipt = await f.db
      .prepare('SELECT status FROM operation_receipts WHERE idempotency_key=?')
      .bind(value.key)
      .first<{ status: string }>();
    const counts = async () =>
      Promise.all(
        ['background_jobs', 'audit_events'].map(
          async (table) =>
            (await f.db
              .prepare(
                `SELECT count(*) n FROM ${table} WHERE agency_id=? ${table === 'audit_events' ? 'AND actor_user_id=?' : 'AND document_version_id IN (SELECT id FROM document_versions WHERE created_by_user_id=?)'}`,
              )
              .bind(value.actor.agencyId, value.actor.id)
              .first<{ n: number }>())!.n,
        ),
      );
    if (mode === 'BEFORE') {
      expect(receipt?.status).toBe('IN_PROGRESS');
      expect(await counts()).toEqual([0, 0]);
    } else {
      expect(receipt?.status).toBe('COMPLETED');
      expect(await counts()).toEqual([1, 1]);
    }
    const fresh = await f.session(value.actor.id),
      token = await value.credentials(fresh.cookie);
    const retry = await runtime.fetch(value.request(fresh.cookie, token), value.env);
    expect(retry.status).toBe(202);
    const body = (await retry.json()) as { replayed: boolean };
    expect(body.replayed).toBe(mode === 'AFTER');
    expect(await counts()).toEqual([1, 1]);
    const exact = await runtime.fetch(value.request(fresh.cookie, token), value.env);
    expect(exact.status).toBe(202);
    expect(((await exact.json()) as { replayed: boolean }).replayed).toBe(true);
    expect(await counts()).toEqual([1, 1]);
  }, 90000);
}

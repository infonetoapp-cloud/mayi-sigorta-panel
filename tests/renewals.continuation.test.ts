// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { localAuthFixture } from './support/local-auth-fixture';
import {
  runRenewalGenerationForAgency,
  runScheduledRenewalGeneration,
  RENEWAL_CONTINUATION_CRON,
} from '../src/server/renewals/generation';
import { createWorker } from '../src/server/index';
import { archivePolicy } from '../src/server/policies/service';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let sequence = 0;
const agency = 'agency-auth-test';
async function insert(id: string, end: string) {
  await f.db
    .prepare(
      `INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency)
    VALUES(?,?,'cont-customer','cont-insurer','cont-product','cont-branch','cont-payment','membership-cont-owner',?,?,'2026-01-01',?,10000,'TRY')`,
    )
    .bind(id, agency, id, id, end)
    .run();
}
async function setup(count: number) {
  const year = 2050 + sequence++;
  vi.setSystemTime(new Date(`${year}-01-02T00:00:00.000Z`));
  await f.db
    .prepare(
      `INSERT INTO renewal_generation_cursors(agency_id,last_successful_local_date,updated_at) VALUES(?,?,?)
    ON CONFLICT(agency_id) DO UPDATE SET last_successful_local_date=excluded.last_successful_local_date,updated_at=excluded.updated_at,continuation_json=NULL,last_attempt_order=0,version=renewal_generation_cursors.version+1`,
    )
    .bind(agency, `${year}-01-01`, `${year}-01-01T00:00:00.000Z`)
    .run();
  for (let i = 0; i < count; i++) await insert(`cont-${year}-${i}`, `${year}-01-15`);
  return year;
}
async function cursor() {
  return f.db
    .prepare('SELECT * FROM renewal_generation_cursors WHERE agency_id=?')
    .bind(agency)
    .first<{
      last_successful_local_date: string;
      continuation_json: string | null;
      version: number;
    }>();
}
async function counts(year: number) {
  return f.db
    .prepare(
      `SELECT
  (SELECT count(*) FROM renewal_opportunities WHERE expiring_policy_id LIKE ?) AS renewals,
  (SELECT count(*) FROM tasks WHERE renewal_id IN (SELECT id FROM renewal_opportunities WHERE expiring_policy_id LIKE ?)) AS tasks,
  (SELECT count(*) FROM renewal_state_history WHERE renewal_id IN (SELECT id FROM renewal_opportunities WHERE expiring_policy_id LIKE ?)) AS history,
  (SELECT count(*) FROM system_audit_events WHERE idempotency_key LIKE ?) AS audits`,
    )
    .bind(`cont-${year}-%`, `cont-${year}-%`, `cont-${year}-%`, `renewal-policy:cont-${year}-%`)
    .first();
}
function interceptBatch(before: (statements: D1PreparedStatement[]) => Promise<void>) {
  return new Proxy(f.db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          await before(statements);
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  f = await localAuthFixture();
  await f.seed('cont-owner', 'OWNER');
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('cont-customer','agency-auth-test','INDIVIDUAL','Synthetic','Syn','Thetic','membership-cont-owner')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('cont-insurer','agency-auth-test','CONT','Synthetic')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('cont-branch','agency-auth-test','CONT','Synthetic','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('cont-product','agency-auth-test','cont-insurer','cont-branch','CONT','Synthetic')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments) VALUES('cont-payment','agency-auth-test','CONT','Synthetic',0,12)",
    ),
    f.db.prepare(
      "INSERT INTO agency_settings(id,agency_id,default_insurer_id) VALUES('cont-settings','agency-auth-test','cont-insurer')",
    ),
  ]);
}, 60000);
afterAll(async () => {
  await f?.mf.dispose();
  vi.useRealTimers();
});
describe('Bounded renewal continuation on real local D1', () => {
  it('retries a crash after an atomic create but before checkpoint without duplicate effects', async () => {
    const year = await setup(6);
    let writes = 0;
    const interrupted = interceptBatch(async (statements) => {
      if (statements.length === 9 && ++writes === 3) throw new Error('INTERRUPTED');
    });
    await expect(runRenewalGenerationForAgency(interrupted, agency)).rejects.toThrow('INTERRUPTED');
    expect(await counts(year)).toEqual({ renewals: 2, tasks: 2, history: 2, audits: 2 });
    expect(JSON.parse((await cursor())!.continuation_json!).key).toBeNull();
    expect((await cursor())!.last_successful_local_date).toBe(`${year}-01-01`);
    await runRenewalGenerationForAgency(f.db, agency);
    expect((await runRenewalGenerationForAgency(f.db, agency)).completedThrough).toBe(
      `${year}-01-02`,
    );
    expect(await counts(year)).toEqual({ renewals: 6, tasks: 6, history: 6, audits: 6 });
  });
  it('detects an eligible policy inserted behind the persisted key immediately before completion', async () => {
    const year = await setup(4);
    await runRenewalGenerationForAgency(f.db, agency);
    let intercepted = false;
    const raced = interceptBatch(async (statements) => {
      if (statements.length === 2 && !intercepted) {
        intercepted = true;
        await insert(`cont-${year}-behind`, `${year}-01-10`);
      }
    });
    expect((await runRenewalGenerationForAgency(raced, agency)).completedThrough).toBeNull();
    expect(intercepted).toBe(true);
    expect(JSON.parse((await cursor())!.continuation_json!).key).toBeNull();
    expect((await cursor())!.last_successful_local_date).toBe(`${year}-01-01`);
    expect((await runRenewalGenerationForAgency(f.db, agency)).completedThrough).toBe(
      `${year}-01-02`,
    );
    expect(await counts(year)).toEqual({ renewals: 5, tasks: 5, history: 5, audits: 5 });
  });
  it('does not skip a changed end date behind the key and ignores a newly ineligible policy', async () => {
    const year = await setup(6);
    await runRenewalGenerationForAgency(f.db, agency);
    await f.db
      .prepare('UPDATE policies SET end_date=?,version=version+1 WHERE id=?')
      .bind(`${year}-01-05`, `cont-${year}-4`)
      .run();
    await archivePolicy(
      {
        userId: 'cont-owner',
        identityId: 'identity-cont-owner',
        assurance: 'NORMAL',
        memberships: [
          {
            id: 'membership-cont-owner',
            agencyId: agency,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      },
      f.db,
      `cont-${year}-5`,
      { expectedVersion: 1, reasonCode: 'HISTORICAL_RECORD' },
      `cont-archive-${year}-5`,
    );
    expect((await runRenewalGenerationForAgency(f.db, agency)).completedThrough).toBeNull();
    expect((await runRenewalGenerationForAgency(f.db, agency)).completedThrough).toBe(
      `${year}-01-02`,
    );
    expect(await counts(year)).toEqual({ renewals: 5, tasks: 5, history: 5, audits: 5 });
  });
  it('finishes the frozen old window after missed days, then recovers the newer window', async () => {
    const year = await setup(5);
    await insert(`cont-${year}-later`, `${year}-02-05`);
    await runRenewalGenerationForAgency(f.db, agency);
    vi.setSystemTime(new Date(`${year}-01-10T00:00:00.000Z`));
    expect((await runRenewalGenerationForAgency(f.db, agency)).completedThrough).toBe(
      `${year}-01-02`,
    );
    expect((await runRenewalGenerationForAgency(f.db, agency)).completedThrough).toBe(
      `${year}-01-10`,
    );
    expect(await counts(year)).toEqual({ renewals: 6, tasks: 6, history: 6, audits: 6 });
  });
  it('converges concurrent resumes at a barrier with one set of effects and monotonic progress', async () => {
    const year = await setup(8);
    await runRenewalGenerationForAgency(f.db, agency);
    let arrivals = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const concurrent = interceptBatch(async (statements) => {
      if (statements.length === 9 && arrivals < 2) {
        if (++arrivals === 2) release();
        await barrier;
      }
    });
    await Promise.all([
      runRenewalGenerationForAgency(concurrent, agency),
      runRenewalGenerationForAgency(concurrent, agency),
    ]);
    expect(arrivals).toBe(2);
    await runRenewalGenerationForAgency(f.db, agency);
    expect((await cursor())!.last_successful_local_date).toBe(`${year}-01-02`);
    expect(await counts(year)).toEqual({ renewals: 8, tasks: 8, history: 8, audits: 8 });
  });
  it('restarts safely on a changed renewal window instead of certifying the old settings', async () => {
    const year = await setup(5);
    await insert(`cont-${year}-wide`, `${year}-02-20`);
    await runRenewalGenerationForAgency(f.db, agency);
    await f.db
      .prepare(
        'UPDATE agency_settings SET renewal_window_days=60,version=version+1 WHERE agency_id=?',
      )
      .bind(agency)
      .run();
    try {
      expect((await runRenewalGenerationForAgency(f.db, agency)).completedThrough).toBe(
        `${year}-01-02`,
      );
      expect(await counts(year)).toEqual({ renewals: 6, tasks: 6, history: 6, audits: 6 });
    } finally {
      await f.db
        .prepare(
          'UPDATE agency_settings SET renewal_window_days=30,version=version+1 WHERE agency_id=?',
        )
        .bind(agency)
        .run();
    }
  });
  it('does not certify a window whose settings change immediately before its final CAS', async () => {
    const year = await setup(4);
    await insert(`cont-${year}-wide`, `${year}-02-20`);
    await runRenewalGenerationForAgency(f.db, agency);
    let intercepted = false;
    const raced = interceptBatch(async (statements) => {
      if (statements.length === 2 && !intercepted) {
        intercepted = true;
        await f.db
          .prepare(
            'UPDATE agency_settings SET renewal_window_days=60,version=version+1 WHERE agency_id=?',
          )
          .bind(agency)
          .run();
      }
    });
    try {
      expect((await runRenewalGenerationForAgency(raced, agency)).completedThrough).toBeNull();
      expect((await cursor())!.last_successful_local_date).toBe(`${year}-01-01`);
      expect((await runRenewalGenerationForAgency(f.db, agency)).completedThrough).toBe(
        `${year}-01-02`,
      );
      expect(await counts(year)).toEqual({ renewals: 5, tasks: 5, history: 5, audits: 5 });
    } finally {
      await f.db
        .prepare(
          'UPDATE agency_settings SET renewal_window_days=30,version=version+1 WHERE agency_id=?',
        )
        .bind(agency)
        .run();
    }
  });
  it('keeps the separate continuation scheduler dormant by default and isolated from document ticks', async () => {
    const year = await setup(6);
    const worker = createWorker();
    async function tick(cron: string, enabled?: string) {
      const work: Promise<unknown>[] = [];
      worker.scheduled(
        { cron } as ScheduledController,
        { DB: f.db, RENEWAL_CONTINUATION_ENABLED: enabled },
        {
          waitUntil: (promise: Promise<unknown>) => work.push(promise),
        } as unknown as ExecutionContext,
      );
      await Promise.all(work);
      return work.length;
    }
    expect(await tick(RENEWAL_CONTINUATION_CRON)).toBe(0);
    expect(await tick(RENEWAL_CONTINUATION_CRON, 'false')).toBe(0);
    expect(await tick('*/5 * * * *', 'true')).toBe(0);
    expect(await tick('0 0 * * *')).toBe(1);
    expect(await tick(RENEWAL_CONTINUATION_CRON, 'true')).toBe(1);
    expect(await counts(year)).toEqual({ renewals: 6, tasks: 6, history: 6, audits: 6 });
    expect((await cursor())!.last_successful_local_date).toBe(`${year}-01-02`);
  });
  it('keeps a cold scheduled invocation including rotation and initialization within 50 statements', async () => {
    const year = await setup(4);
    await f.db
      .prepare('DELETE FROM renewal_generation_cursors WHERE agency_id=?')
      .bind(agency)
      .run();
    let statements = 0,
      maxRows = 0;
    function charge(count: number) {
      statements += count;
      if (statements > 50) throw new Error('LOCAL_STATEMENT_BUDGET');
    }
    function wrap(statement: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(statement, {
        get(target, key) {
          if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
          const value = Reflect.get(target, key, target);
          if (['all', 'first', 'run', 'raw'].includes(String(key)))
            return async (...args: unknown[]) => {
              charge(1);
              const result = await value.apply(target, args);
              if (key === 'all') maxRows = Math.max(maxRows, result.results.length);
              return result;
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    const bounded = new Proxy(f.db, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql));
        if (key === 'batch')
          return (batch: D1PreparedStatement[]) => {
            charge(batch.length);
            return target.batch(batch);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect((await runScheduledRenewalGeneration(bounded)).createdCount).toBe(4);
    expect(statements).toBeLessThanOrEqual(50);
    expect(maxRows).toBeLessThanOrEqual(4);
    expect(await counts(year)).toEqual({ renewals: 4, tasks: 4, history: 4, audits: 4 });
    expect((await cursor())!.last_successful_local_date).toBeNull();
  });
  it('does not starve a partial same-day agency behind an already completed agency', async () => {
    const year = await setup(6);
    await f.db
      .prepare(
        'UPDATE renewal_generation_cursors SET last_successful_local_date=? WHERE agency_id=?',
      )
      .bind(`${year}-01-02`, agency)
      .run();
    await runRenewalGenerationForAgency(f.db, agency);
    await f.seed('other-cont-owner', 'OWNER', false, 'other-completed-agency');
    await f.db
      .prepare(
        "INSERT INTO renewal_generation_cursors(agency_id,last_successful_local_date,updated_at) VALUES('other-completed-agency',?,?)",
      )
      .bind(`${year}-01-02`, `${year}-01-01T00:00:00.000Z`)
      .run();
    const work: Promise<unknown>[] = [];
    createWorker().scheduled(
      { cron: RENEWAL_CONTINUATION_CRON } as ScheduledController,
      { DB: f.db, RENEWAL_CONTINUATION_ENABLED: 'true' },
      {
        waitUntil: (promise: Promise<unknown>) => work.push(promise),
      } as unknown as ExecutionContext,
    );
    await Promise.all(work);
    expect(await counts(year)).toEqual({ renewals: 6, tasks: 6, history: 6, audits: 6 });
    expect((await cursor())!.continuation_json).toBeNull();
    expect(
      await f.db
        .prepare(
          "SELECT last_successful_local_date,updated_at FROM renewal_generation_cursors WHERE agency_id='other-completed-agency'",
        )
        .first(),
    ).toEqual({
      last_successful_local_date: `${year}-01-02`,
      updated_at: `${year}-01-01T00:00:00.000Z`,
    });
  });
  it('rotates a permanently broken agency without advancing its completed date or starving healthy work', async () => {
    const year = await setup(1);
    await f.db
      .prepare('UPDATE renewal_generation_cursors SET continuation_json=? WHERE agency_id=?')
      .bind('{"broken":true}', agency)
      .run();
    await f.seed('healthy-cont-owner', 'OWNER', false, 'healthy-cont-agency');
    await f.db.batch([
      f.db.prepare(
        "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('healthy-customer','healthy-cont-agency','INDIVIDUAL','Synthetic','Syn','Thetic','membership-healthy-cont-owner')",
      ),
      f.db.prepare(
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('healthy-insurer','healthy-cont-agency','HEALTHY','Synthetic')",
      ),
      f.db.prepare(
        "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('healthy-branch','healthy-cont-agency','HEALTHY','Synthetic','GENERAL')",
      ),
      f.db.prepare(
        "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('healthy-product','healthy-cont-agency','healthy-insurer','healthy-branch','HEALTHY','Synthetic')",
      ),
      f.db.prepare(
        "INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments) VALUES('healthy-payment','healthy-cont-agency','HEALTHY','Synthetic',0,12)",
      ),
      f.db
        .prepare(
          `INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency)
        VALUES('healthy-policy','healthy-cont-agency','healthy-customer','healthy-insurer','healthy-product','healthy-branch','healthy-payment','membership-healthy-cont-owner','HEALTHY','HEALTHY','2026-01-01',?,10000,'TRY')`,
        )
        .bind(`${year}-01-15`),
    ]);
    await expect(runScheduledRenewalGeneration(f.db, true)).rejects.toThrow(
      'RENEWAL_GENERATION_CURSOR_INVALID',
    );
    await expect(runScheduledRenewalGeneration(f.db, true)).resolves.toMatchObject({
      agenciesProcessed: 1,
      createdCount: 1,
    });
    expect((await cursor())!.last_successful_local_date).toBe(`${year}-01-01`);
    expect((await cursor())!.continuation_json).toBe('{"broken":true}');
    expect(
      await f.db
        .prepare(
          "SELECT last_successful_local_date FROM renewal_generation_cursors WHERE agency_id='healthy-cont-agency'",
        )
        .first(),
    ).toEqual({ last_successful_local_date: `${year}-01-02` });
    expect(
      await f.db
        .prepare(
          "SELECT count(*) AS count FROM renewal_opportunities WHERE agency_id='healthy-cont-agency' AND expiring_policy_id='healthy-policy'",
        )
        .first(),
    ).toEqual({ count: 1 });
  });
  it('fails closed on malformed saved continuation', async () => {
    await setup(1);
    await f.db
      .prepare('UPDATE renewal_generation_cursors SET continuation_json=? WHERE agency_id=?')
      .bind('{"offset":999}', agency)
      .run();
    await expect(runRenewalGenerationForAgency(f.db, agency)).rejects.toThrow(
      'RENEWAL_GENERATION_CURSOR_INVALID',
    );
  });
  it('upgrades a populated previous cursor schema without rewriting its completion date or version', async () => {
    // Separate native D1 database on the same Miniflare runtime is not configured;
    // a fresh isolated runtime makes the pre-migration upgrade proof explicit.
    const miniflare = (await import('miniflare')).default;
    const mf = new miniflare.Miniflare(
      miniflare.convertV4MiniflareOptions({
        modules: true,
        script: 'export default {fetch(){return new Response()}}',
        d1Databases: { DB: '00000000-0000-0000-0000-000000000077' },
      }),
    );
    try {
      const db = await mf.getD1Database('DB');
      for (const name of readdirSync('db/migrations')
        .filter((name) => /^\d{4}.*\.sql$/.test(name) && !name.startsWith('0022'))
        .sort())
        for (const statement of readFileSync('db/migrations/' + name, 'utf8')
          .split('--> statement-breakpoint')
          .map((value) => value.trim())
          .filter(Boolean))
          await db.prepare(statement).run();
      await db.prepare("INSERT INTO agencies(id,status) VALUES('upgrade','PROVISIONING')").run();
      await db
        .prepare(
          "INSERT INTO renewal_generation_cursors(agency_id,last_successful_local_date,version,updated_at) VALUES('upgrade','2026-10-17',7,'2026-10-17T00:00:00.000Z')",
        )
        .run();
      for (const statement of readFileSync(
        'db/migrations/0022_renewal_generation_continuation.sql',
        'utf8',
      )
        .split('--> statement-breakpoint')
        .map((value) => value.trim())
        .filter(Boolean))
        await db.prepare(statement).run();
      expect(
        await db
          .prepare("SELECT * FROM renewal_generation_cursors WHERE agency_id='upgrade'")
          .first(),
      ).toEqual({
        agency_id: 'upgrade',
        last_successful_local_date: '2026-10-17',
        version: 7,
        updated_at: '2026-10-17T00:00:00.000Z',
        continuation_json: null,
        last_attempt_order: 0,
      });
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    } finally {
      await mf.dispose();
    }
  }, 60000);
});

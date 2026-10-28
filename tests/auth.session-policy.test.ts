// @vitest-environment node
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createApp, createWorker } from '../src/server/index';
import { createLocalSessionVerifier } from '../src/server/auth/session';
import { createApplicationIdentityResolver } from '../src/server/auth/identity';
import { sessionBoundDatabase } from '../src/server/auth/session-database';
import {
  createAuthorizationEvaluator,
  createActionRegistry,
  DEFAULT_ACTION_REGISTRY,
} from '../src/server/auth/authorization';
import { loadLocalSession } from '../src/server/auth/session';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('policy-root', 'OWNER');
  f.env.DB = { prepare: f.db.prepare.bind(f.db), batch: f.db.batch.bind(f.db) } as D1Database;
});
afterAll(async () => {
  await f?.mf.dispose();
});

it.each([
  ['/secure/api/personnel/commands', 401],
  ['/%73ecure/api/personnel/commands', 404],
  ['/secure%2fapi/personnel/commands', 404],
  ['/api/personnel/commands', 404],
] as const)(
  'secure canonical/alias path %s cannot accept a normal session or body assurance downgrade',
  async (path, status) => {
    const session = await f.session('policy-root');
    const response = await createWorker(f.app).fetch(
      new Request(`https://panel.mayisigorta.com${path}`, {
        method: 'POST',
        headers: {
          cookie: session.cookie,
          origin: 'https://panel.mayisigorta.com',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ assurance: 'NORMAL', command: { kind: 'permissions' } }),
      }),
      f.env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(status);
  },
);

it('native D1 secure freshness denies even if the server clock captured before batch still says recent', async () => {
  const actor = await f.seed('native-freshness');
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 300001);
  try {
    const session = await f.session(actor.id, true);
    clock.mockReturnValue(now - 2);
    const row = await loadLocalSession(
      f.db,
      new Request('https://panel.mayisigorta.com/api/customers', {
        headers: { cookie: session.cookie },
      }),
    );
    const statement = () =>
      f.db
        .prepare('UPDATE users SET display_name=?,version=version+1 WHERE id=?')
        .bind('Native normal allowed', actor.id);
    await expect(sessionBoundDatabase(f.db, row, true).batch([statement()])).rejects.toThrow();
    await sessionBoundDatabase(f.db, row).batch([statement()]);
    expect(
      (
        await f.db
          .prepare('SELECT display_name FROM users WHERE id=?')
          .bind(actor.id)
          .first<{ display_name: string }>()
      )?.display_name,
    ).toBe('Native normal allowed');
  } finally {
    clock.mockRestore();
  }
});

it('secure grant issuance expiry after preflight rolls back grant, receipt and SUCCESS audit', async () => {
  const target = await f.seed('issuance-boundary');
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const session = await f.session('policy-root', true);
  const csrf = await f.csrf(session.cookie);
  const key = crypto.randomUUID();
  clock.mockReturnValue(now + 299999);
  const original = f.env.DB.prepare.bind(f.env.DB);
  let arrivals = 0;
  const barrier = vi.spyOn(f.env.DB, 'prepare').mockImplementation((sql) => {
    if (sql.includes('INSERT INTO audit_events')) {
      arrivals++;
      clock.mockReturnValue(now + 300001);
    }
    return original(sql);
  });
  try {
    const response = await f.request(
      '/secure/api/personnel/grants',
      'POST',
      session.cookie,
      {
        kind: 'permissions',
        targetId: target.membershipId,
        expectedVersion: 1,
        grants: [],
        reason: 'Synthetic authorized correction',
      },
      csrf,
      { 'idempotency-key': key },
    );
    expect(arrivals).toBeGreaterThan(0);
    expect(response.status).not.toBe(200);
    expect(
      (
        await f.db
          .prepare('SELECT id FROM credential_operation_receipts WHERE operation_key=?')
          .bind(`grant:${key}`)
          .all()
      ).results,
    ).toHaveLength(0);
    expect(
      (
        await f.db
          .prepare('SELECT id FROM sensitive_action_grants WHERE target_ids_json=?')
          .bind(JSON.stringify([target.membershipId]))
          .all()
      ).results,
    ).toHaveLength(0);
    expect(
      (
        await f.db
          .prepare("SELECT id FROM audit_events WHERE idempotency_key=? AND outcome='SUCCESS'")
          .bind(`grant:${key}`)
          .all()
      ).results,
    ).toHaveLength(0);
  } finally {
    barrier.mockRestore();
    clock.mockRestore();
  }
});
it('NORMAL customer.create commits once with audit when optional recent password expires between preflight and native D1 batch', async () => {
  const actor = await f.seed('policy-normal');
  for (const [permission, scope] of [
    ['customer.read', 'AGENCY'],
    ['customer.create', 'UNSCOPED'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), actor.membershipId, permission, scope)
      .run();
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const session = await f.session(actor.id, true);
  const csrf = await f.csrf(session.cookie);
  clock.mockReturnValue(now + 299999);
  const batch = vi.spyOn(f.env.DB, 'batch');
  const app = createApp({
    createSessionVerifier(config) {
      if (config.db !== f.env.DB) {
        const original = config.db.batch.bind(config.db);
        config.db.batch = (statements) => {
          clock.mockReturnValue(now + 300001);
          return original(statements);
        };
      }
      return createLocalSessionVerifier({ config });
    },
  });
  const key = crypto.randomUUID();
  try {
    const response = await app.fetch(
      new Request('https://panel.mayisigorta.com/api/customers', {
        method: 'POST',
        headers: {
          cookie: session.cookie,
          origin: 'https://panel.mayisigorta.com',
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          'idempotency-key': key,
        },
        body: JSON.stringify({ type: 'INDIVIDUAL', firstName: 'Synthetic', lastName: 'Boundary' }),
      }),
      f.env,
    );
    expect(response.status, JSON.stringify(await response.json())).toBe(201);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.db
          .prepare('SELECT id FROM customers WHERE assignee_membership_id=?')
          .bind(actor.membershipId)
          .all()
      ).results,
    ).toHaveLength(1);
    expect(
      (
        await f.db
          .prepare(
            "SELECT id FROM audit_events WHERE actor_user_id=? AND action='customer.create' AND outcome='SUCCESS'",
          )
          .bind(actor.id)
          .all()
      ).results,
    ).toHaveLength(1);
  } finally {
    batch.mockRestore();
    clock.mockRestore();
  }
});

it.each(['expired', 'never', 'fresh'] as const)(
  'NORMAL customer.create accepts %s optional assurance with explicit MEMBER permissions',
  async (kind) => {
    const actor = await f.seed(`normal-${kind}`);
    for (const [permission, scope] of [
      ['customer.read', 'AGENCY'],
      ['customer.create', 'UNSCOPED'],
    ])
      await f.db
        .prepare(
          'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
        )
        .bind(crypto.randomUUID(), actor.membershipId, permission, scope)
        .run();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const session = await f.session(actor.id, kind !== 'never');
      const csrf = await f.csrf(session.cookie);
      if (kind === 'expired') clock.mockReturnValue(now + 300001);
      const key = crypto.randomUUID();
      const response = await f.request(
        '/api/customers',
        'POST',
        session.cookie,
        { type: 'INDIVIDUAL', firstName: 'Synthetic', lastName: kind },
        csrf,
        { 'idempotency-key': key },
      );
      expect(response.status).toBe(201);
      expect(
        (
          await f.db
            .prepare('SELECT id FROM customers WHERE assignee_membership_id=?')
            .bind(actor.membershipId)
            .all()
        ).results,
      ).toHaveLength(1);
      expect(
        (
          await f.db
            .prepare(
              "SELECT id FROM audit_events WHERE actor_user_id=? AND action='customer.create' AND outcome='SUCCESS'",
            )
            .bind(actor.id)
            .all()
        ).results,
      ).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  },
);

it.each(['expired', 'fresh'] as const)(
  'secure personnel mutation %s at batch boundary preserves effect/receipt/consume/audit atomicity',
  async (kind) => {
    const target = await f.seed(`secure-target-${kind}`);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const session = await f.session('policy-root', true);
    const csrf = await f.csrf(session.cookie);
    const command = {
      kind: 'permissions',
      targetId: target.membershipId,
      expectedVersion: 1,
      grants: [],
      reason: 'Synthetic authorized correction',
    };
    const key = crypto.randomUUID();
    const headers = { 'idempotency-key': key };
    try {
      clock.mockReturnValue(now + 299999);
      const issue = await f.request(
        '/secure/api/personnel/grants',
        'POST',
        session.cookie,
        command,
        csrf,
        headers,
      );
      expect(issue.status).toBe(200);
      const evidence = ((await issue.json()) as { data: { grantEvidenceToken: string } }).data
        .grantEvidenceToken;
      clock.mockReturnValue(now + 299999);
      const original = f.env.DB.prepare.bind(f.env.DB);
      let arrivals = 0;
      const barrier = vi.spyOn(f.env.DB, 'prepare').mockImplementation((sql) => {
        if (sql.includes('INSERT INTO audit_events')) {
          arrivals++;
          clock.mockReturnValue(now + (kind === 'expired' ? 300001 : 299999));
        }
        return original(sql);
      });
      let response: Response;
      try {
        response = await f.request(
          '/secure/api/personnel/commands',
          'POST',
          session.cookie,
          { command, grantEvidenceToken: evidence },
          csrf,
          headers,
        );
      } finally {
        barrier.mockRestore();
      }
      expect(arrivals).toBeGreaterThan(0);
      expect(response.status).toBe(kind === 'fresh' ? 200 : 409);
      expect(
        (
          await f.db
            .prepare('SELECT version FROM agency_memberships WHERE id=?')
            .bind(target.membershipId)
            .first<{ version: number }>()
        )?.version,
      ).toBe(kind === 'fresh' ? 2 : 1);
      expect(
        (
          await f.db
            .prepare('SELECT id FROM credential_operation_receipts WHERE operation_key=?')
            .bind(key)
            .all()
        ).results,
      ).toHaveLength(kind === 'fresh' ? 1 : 0);
      expect(
        (
          await f.db
            .prepare(
              "SELECT id FROM audit_events WHERE action='personnel.permissions' AND idempotency_key=? AND outcome='SUCCESS'",
            )
            .bind(key)
            .all()
        ).results,
      ).toHaveLength(kind === 'fresh' ? 1 : 0);
      expect(
        (
          await f.db
            .prepare(
              "SELECT id FROM sensitive_action_grants WHERE actor_user_id='policy-root' AND target_ids_json=? AND status='CONSUMED'",
            )
            .bind(JSON.stringify([target.membershipId]))
            .all()
        ).results,
      ).toHaveLength(kind === 'fresh' ? 1 : 0);
    } finally {
      clock.mockRestore();
    }
  },
);

it('canonical secure action cannot be downgraded by caller assurance or a normal registry override and later normal checks', async () => {
  const actor = await f.seed('canonical-actor', 'OWNER');
  const session = await f.session(actor.id, true);
  const request = new Request('https://panel.mayisigorta.com/api/customers', {
    headers: { cookie: session.cookie },
  });
  const row = await loadLocalSession(f.db, request);
  const scoped = sessionBoundDatabase(f.db, row);
  const principal = await createLocalSessionVerifier({
    config: { db: scoped, origin: 'https://panel.mayisigorta.com' },
  }).verify(request);
  const context = await createApplicationIdentityResolver(scoped).resolve(principal);
  const descriptor = DEFAULT_ACTION_REGISTRY.get('personnel.permissions')!;
  const evaluator = createAuthorizationEvaluator({
    db: scoped,
    actions: createActionRegistry([{ ...descriptor, assurance: 'NORMAL_SESSION' }]),
  });
  expect(
    (
      await evaluator.authorize({
        context: { ...context, assurance: 'NORMAL' },
        action: descriptor.code,
      })
    ).decision,
  ).toBe('DENY');
  await createAuthorizationEvaluator({ db: scoped }).authorize({
    context,
    action: 'customer.read',
  });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(row.recent_password_at! + 300001);
  try {
    await expect(
      scoped.batch([
        f.db
          .prepare('UPDATE users SET display_name=?,version=version+1 WHERE id=?')
          .bind('Must not commit', actor.id),
      ]),
    ).rejects.toThrow();
    expect(
      (
        await f.db
          .prepare('SELECT display_name FROM users WHERE id=?')
          .bind(actor.id)
          .first<{ display_name: string }>()
      )?.display_name,
    ).not.toBe('Must not commit');
  } finally {
    clock.mockRestore();
  }
});

it.each(['NORMAL', 'SECURE'] as const)(
  '%s atomic session policy preserves every base live check',
  async (policy) => {
    for (const state of [
      'revoked',
      'credential',
      'pver',
      'user',
      'identity',
      'membership',
      'agency',
      'idle',
      'absolute',
      'tenant',
    ] as const) {
      const prefix = policy.toLowerCase();
      const agencyId = `base-${prefix}-${state}`;
      await f.seed(`owner-${prefix}-${state}`, 'OWNER', false, agencyId);
      const actor = await f.seed(`base-${prefix}-${state}`, 'MEMBER', false, agencyId);
      const session = await f.session(actor.id, true);
      const request = new Request('https://panel.mayisigorta.com/api/customers', {
        headers: { cookie: session.cookie },
      });
      const row = await loadLocalSession(f.db, request);
      const scoped = sessionBoundDatabase(
        f.db,
        state === 'tenant' ? { ...row, agency_id: 'wrong-agency' } : row,
        policy === 'SECURE',
      );
      if (state === 'revoked')
        await f.db
          .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
          .bind(Date.now(), session.hash)
          .run();
      if (state === 'credential')
        await f.db
          .prepare(
            'UPDATE local_credentials SET credential_version=credential_version+1 WHERE user_id=?',
          )
          .bind(actor.id)
          .run();
      if (state === 'pver')
        await f.db
          .prepare(
            'UPDATE agency_memberships SET version=version+1,permission_version=permission_version+1 WHERE id=?',
          )
          .bind(actor.membershipId)
          .run();
      if (state === 'user')
        await f.db
          .prepare("UPDATE users SET status='INACTIVE',version=version+1 WHERE id=?")
          .bind(actor.id)
          .run();
      if (state === 'identity')
        await f.db
          .prepare(
            "UPDATE auth_identities SET status='REVOKED',revoked_at=?,version=version+1 WHERE id=?",
          )
          .bind(new Date().toISOString(), actor.identityId)
          .run();
      if (state === 'membership')
        await f.db
          .prepare(
            "UPDATE agency_memberships SET status='SUSPENDED',suspended_at=?,version=version+1,permission_version=permission_version+1 WHERE id=?",
          )
          .bind(new Date().toISOString(), actor.membershipId)
          .run();
      if (state === 'agency') {
        await expect(
          f.db
            .prepare("UPDATE agencies SET status='PROVISIONING',version=version+1 WHERE id=?")
            .bind(agencyId)
            .run(),
        ).rejects.toThrow('ACTIVE_AGENCY_CANNOT_RETURN_TO_PROVISIONING');
        // Isolated synthetic corruption fixture: preserve/reinstall the exact native guard.
        const guard = (await f.db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='agencies_update_guard'",
          )
          .first<{ sql: string }>())!.sql;
        await f.db.prepare('DROP TRIGGER agencies_update_guard').run();
        try {
          await f.db
            .prepare(
              "UPDATE agencies SET status='PROVISIONING',bootstrap_completed_at=NULL,activated_at=NULL,version=version+1 WHERE id=?",
            )
            .bind(agencyId)
            .run();
        } finally {
          await f.db.prepare(guard).run();
        }
      }
      const clock = vi
        .spyOn(Date, 'now')
        .mockReturnValue(
          state === 'idle'
            ? row.last_seen_at + 28800000
            : state === 'absolute'
              ? row.expires_at
              : Date.now(),
        );
      try {
        await expect(
          scoped.batch([
            f.db
              .prepare('UPDATE users SET display_name=?,version=version+1 WHERE id=?')
              .bind('Must not commit', actor.id),
          ]),
        ).rejects.toThrow();
        expect(
          (
            await f.db
              .prepare('SELECT display_name FROM users WHERE id=?')
              .bind(actor.id)
              .first<{ display_name: string }>()
          )?.display_name,
          state,
        ).not.toBe('Must not commit');
      } finally {
        clock.mockRestore();
      }
    }
  },
);

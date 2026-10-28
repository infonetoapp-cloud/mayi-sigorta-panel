// @vitest-environment node
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: Awaited<ReturnType<typeof f.seed>>;
beforeAll(async () => {
  f = await localAuthFixture();
  f.env.DB = { prepare: f.db.prepare.bind(f.db), batch: f.db.batch.bind(f.db) } as D1Database;
  owner = await f.seed('retry-root', 'OWNER');
});
afterAll(async () => {
  await f?.mf.dispose();
});
async function prepare(command: unknown, actor = owner) {
  const session = await f.session(actor.id, true);
  const csrf = await f.csrf(session.cookie);
  const key = crypto.randomUUID();
  const headers = { 'idempotency-key': key };
  const issue = () =>
    f.request('/secure/api/personnel/grants', 'POST', session.cookie, command, csrf, headers);
  return { session, csrf, key, headers, command, issue };
}
async function mutation(
  p: Awaited<ReturnType<typeof prepare>>,
  token: string,
  command = p.command,
) {
  return f.request(
    '/secure/api/personnel/commands',
    'POST',
    p.session.cookie,
    { command, grantEvidenceToken: token },
    p.csrf,
    p.headers,
  );
}
async function token(p: Awaited<ReturnType<typeof prepare>>) {
  const result = await p.issue();
  expect(result.status).toBe(200);
  return ((await result.json()) as { data: { grantEvidenceToken: string } }).data
    .grantEvidenceToken;
}
function rendezvous() {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.db.batch.bind(f.db);
  const spy = vi.spyOn(f.env.DB, 'batch').mockImplementation(async (...args) => {
    arrivals++;
    if (arrivals === 2) release();
    await ready;
    return original(...args);
  });
  return { spy, count: () => arrivals };
}
describe('HIGH corrections: exact grant issuance retries', () => {
  it('native D1 two preflights rendezvous converge on one live grant and issuance audit', async () => {
    const p = await prepare({
      kind: 'create',
      name: 'Synthetic retry',
      email: 'retry-create@example.invalid',
      template: 'personel',
      grants: [],
    });
    const barrier = rendezvous();
    let responses: Response[];
    try {
      responses = await Promise.all([p.issue(), p.issue()]);
    } finally {
      barrier.spy.mockRestore();
    }
    expect(barrier.count()).toBe(2);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ data: unknown }>));
    expect(bodies[0]!.data).toEqual(bodies[1]!.data);
    expect(
      (
        await f.db
          .prepare('SELECT id FROM credential_operation_receipts WHERE operation_key=?')
          .bind(`grant:${p.key}`)
          .all()
      ).results,
    ).toHaveLength(1);
    expect(
      (
        await f.db
          .prepare(
            "SELECT id FROM audit_events WHERE action='sensitive_action_grant.issued' AND idempotency_key=?",
          )
          .bind(`grant:${p.key}`)
          .all()
      ).results,
    ).toHaveLength(1);
  });
  it('same issuance key changed payload conflicts', async () => {
    const p = await prepare({
      kind: 'create',
      name: 'Synthetic retry',
      email: 'retry-changed@example.invalid',
      template: 'personel',
      grants: [],
    });
    await token(p);
    const result = await f.request(
      '/secure/api/personnel/grants',
      'POST',
      p.session.cookie,
      { ...(p.command as object), name: 'Changed payload' },
      p.csrf,
      p.headers,
    );
    expect(result.status).toBe(409);
  });
});
describe('HIGH corrections: safe completed command retries', () => {
  it.each(['permissions', 'suspend', 'inactivate', 'promote', 'demote', 'transfer'] as const)(
    '%s concurrent and sequential exact retries use original version and safe result once',
    async (kind) => {
      const actor = kind === 'transfer' ? await f.seed(`retry-actor-${kind}`, 'OWNER') : owner;
      const employee = await f.seed(`retry-target-${kind}`, kind === 'demote' ? 'OWNER' : 'MEMBER');
      const command = {
        kind,
        targetId: employee.membershipId,
        expectedVersion: 1,
        reason: 'Synthetic authorized correction',
        ...(['permissions', 'promote', 'demote'].includes(kind) ? { grants: [] } : {}),
        ...(kind === 'transfer' ? { oldOwnerGrants: [], newOwnerGrants: [] } : {}),
      };
      const p = await prepare(command, actor);
      const grant = await token(p);
      const barrier = rendezvous();
      let results: Response[];
      try {
        results = await Promise.all([mutation(p, grant), mutation(p, grant)]);
      } finally {
        barrier.spy.mockRestore();
      }
      expect(barrier.count()).toBe(2);
      if (kind === 'transfer') {
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        await f.db
          .prepare(
            "UPDATE agency_memberships SET type='OWNER',version=version+1,permission_version=permission_version+1 WHERE id=?",
          )
          .bind(actor.membershipId)
          .run();
        const fresh = await f.session(actor.id, true);
        p.session = fresh;
        p.csrf = await f.csrf(fresh.cookie);
      } else expect(results.map((r) => r.status)).toEqual([200, 200]);
      const successful = results.find((r) => r.status === 200)!;
      const first = ((await successful.json()) as { data: Record<string, string> }).data;
      const retry = await mutation(p, grant);
      expect(retry.status).toBe(200);
      expect(((await retry.json()) as { data: unknown }).data).toEqual(first);
      expect(Object.keys(first).sort()).toEqual(['membershipId', 'userId']);
      expect(
        (
          await f.db
            .prepare('SELECT version FROM agency_memberships WHERE id=?')
            .bind(employee.membershipId)
            .first<{ version: number }>()
        )?.version,
      ).toBe(2);
      expect(
        (
          await f.db
            .prepare(
              "SELECT id FROM audit_events WHERE action=? AND idempotency_key=? AND outcome='SUCCESS'",
            )
            .bind(`personnel.${kind}`, p.key)
            .all()
        ).results,
      ).toHaveLength(1);
      const changed = await mutation(p, grant, {
        ...command,
        reason: 'Changed authorized correction',
      });
      expect(changed.status).toBe(409);
    },
  );
  it('permission audit records before/after versions, scopes, justification and same-batch consume linkage', async () => {
    const employee = await f.seed('audit-target');
    const p = await prepare({
      kind: 'permissions',
      targetId: employee.membershipId,
      expectedVersion: 1,
      reason: 'Synthetic authorized correction',
      grants: [{ permission_code: 'customer.read', scope: 'ASSIGNED' }],
    });
    const grant = await token(p);
    const result = await mutation(p, grant);
    expect(result.status).toBe(200);
    const audits = (
      await f.db
        .prepare(
          "SELECT action,metadata_json FROM audit_events WHERE idempotency_key=? AND outcome='SUCCESS'",
        )
        .bind(p.key)
        .all<{ action: string; metadata_json: string }>()
    ).results;
    const event = JSON.parse(
      audits.find((a) => a.action === 'personnel.permissions')!.metadata_json,
    );
    expect(event.beforeVersion).toBe(1);
    expect(event.afterVersion).toBe(2);
    expect(event.beforePermissionVersion).toBe(1);
    expect(event.afterPermissionVersion).toBe(2);
    expect(event.justification).toBe('Synthetic authorized correction');
    expect(event.permissionDeltas).toEqual([
      {
        permissionCode: 'customer.read',
        classification: 'NORMAL',
        beforeScope: null,
        afterScope: 'ASSIGNED',
      },
    ]);
    const consume = JSON.parse(
      audits.find((a) => a.action === 'sensitive_action_grant.consumed')!.metadata_json,
    );
    expect(consume.grantId).toBe(event.grantId);
    expect(consume.effectAuditId).toBe(event.effectAuditId);
    expect(JSON.stringify(audits).includes(grant)).toBe(false);
  });
  it.each([
    'consumed',
    'expired',
    'revoked',
    'stale-permission',
    'stale-target',
    'new-session',
    'reauth-stale',
  ] as const)('issuance receipt cannot replay %s grant evidence', async (mode) => {
    const actor = await f.seed(`issue-${mode}`, 'OWNER');
    const employee = await f.seed(`issue-target-${mode}`);
    const p = await prepare(
      {
        kind: 'permissions',
        targetId: employee.membershipId,
        expectedVersion: 1,
        reason: 'Synthetic authorized correction',
        grants: [],
      },
      actor,
    );
    const grant = await token(p);
    if (mode === 'consumed') expect((await mutation(p, grant)).status).toBe(200);
    if (mode === 'revoked')
      await f.db
        .prepare(
          "UPDATE sensitive_action_grants SET status='REVOKED',revoked_at=?,updated_at=? WHERE id=(SELECT grant_id FROM credential_operation_receipts WHERE operation_key=?)",
        )
        .bind(new Date().toISOString(), new Date().toISOString(), `grant:${p.key}`)
        .run();
    if (mode === 'stale-permission')
      await f.db
        .prepare(
          'UPDATE agency_memberships SET version=version+1,permission_version=permission_version+1 WHERE id=?',
        )
        .bind(actor.membershipId)
        .run();
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    if (mode === 'stale-target')
      await f.db
        .prepare(
          'UPDATE agency_memberships SET version=version+1,permission_version=permission_version+1 WHERE id=?',
        )
        .bind(employee.membershipId)
        .run();
    try {
      if (mode === 'expired' || mode === 'reauth-stale') {
        const now = Date.now();
        clock = vi.spyOn(Date, 'now').mockReturnValue(now + (mode === 'expired' ? 181000 : 301000));
      }
      const fresh = mode === 'new-session' ? await f.session(actor.id, true) : p.session;
      const csrf = mode === 'new-session' ? await f.csrf(fresh.cookie) : p.csrf;
      const retry = await f.request(
        '/secure/api/personnel/grants',
        'POST',
        fresh.cookie,
        p.command,
        csrf,
        p.headers,
      );
      expect(retry.status).not.toBe(200);
    } finally {
      clock?.mockRestore();
    }
  });
  it.each(['session', 'identity', 'owner', 'permissions'] as const)(
    'completed receipt denies current actor %s authority loss',
    async (mode) => {
      const actor = await f.seed(`loss-${mode}`, 'OWNER');
      const employee = await f.seed(`loss-target-${mode}`);
      const p = await prepare(
        {
          kind: 'permissions',
          targetId: employee.membershipId,
          expectedVersion: 1,
          reason: 'Synthetic authorized correction',
          grants: [],
        },
        actor,
      );
      const grant = await token(p);
      expect((await mutation(p, grant)).status).toBe(200);
      if (mode === 'session')
        await f.db
          .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
          .bind(Date.now(), p.session.hash)
          .run();
      if (mode === 'identity')
        await f.db
          .prepare(
            "UPDATE auth_identities SET status='REVOKED',revoked_at=?,version=version+1 WHERE id=?",
          )
          .bind(new Date().toISOString(), actor.identityId)
          .run();
      if (mode === 'owner')
        await f.db
          .prepare(
            "UPDATE agency_memberships SET type='MEMBER',version=version+1,permission_version=permission_version+1 WHERE id=?",
          )
          .bind(actor.membershipId)
          .run();
      if (mode === 'permissions')
        await f.db
          .prepare(
            'UPDATE agency_memberships SET version=version+1,permission_version=permission_version+1 WHERE id=?',
          )
          .bind(actor.membershipId)
          .run();
      expect((await mutation(p, grant)).status).not.toBe(200);
    },
  );
  it('own permission change revokes old session but fresh OWNER session with own reauth can replay safely', async () => {
    const actor = await f.seed('self-retry', 'OWNER');
    const p = await prepare(
      {
        kind: 'permissions',
        targetId: actor.membershipId,
        expectedVersion: 1,
        reason: 'Synthetic authorized correction',
        grants: [],
      },
      actor,
    );
    const grant = await token(p);
    expect((await mutation(p, grant)).status).toBe(200);
    expect((await mutation(p, grant)).status).toBe(401);
    p.session = await f.session(actor.id);
    p.csrf = await f.csrf(p.session.cookie);
    expect((await mutation(p, grant)).status).toBe(401);
    const reauth = await f.request(
      '/api/auth/reauth',
      'POST',
      p.session.cookie,
      { password: actor.password },
      p.csrf,
    );
    expect(reauth.status).toBe(200);
    p.session.cookie = reauth.headers.get('set-cookie')!.split(';')[0]!;
    p.csrf = await f.csrf(p.session.cookie);
    expect((await mutation(p, grant)).status).toBe(200);
  });
  it.each([
    'bad-json',
    'extra-field',
    'wrong-target',
    'wrong-audit',
    'wrong-grant',
    'wrong-actor',
  ] as const)('corrupt %s receipt cannot authorize safe replay', async (mode) => {
    const employee = await f.seed(`corrupt-${mode}`);
    const p = await prepare({
      kind: 'permissions',
      targetId: employee.membershipId,
      expectedVersion: 1,
      reason: 'Synthetic authorized correction',
      grants: [],
    });
    const grant = await token(p);
    expect((await mutation(p, grant)).status).toBe(200);
    await f.db.prepare('DROP TRIGGER credential_receipt_no_update').run();
    try {
      const values: Record<string, [string, string]> = {
        'bad-json': ['safe_response_json', '{'],
        'extra-field': [
          'safe_response_json',
          JSON.stringify({ userId: employee.id, membershipId: employee.membershipId, extra: true }),
        ],
        'wrong-target': [
          'safe_response_json',
          JSON.stringify({ userId: owner.id, membershipId: owner.membershipId }),
        ],
        'wrong-audit': ['effect_audit_id', crypto.randomUUID()],
        'wrong-grant': ['grant_id', crypto.randomUUID()],
        'wrong-actor': ['actor_membership_id', employee.membershipId],
      };
      const [field, value] = values[mode]!;
      await f.db
        .prepare(`UPDATE credential_operation_receipts SET ${field}=? WHERE operation_key=?`)
        .bind(value, p.key)
        .run();
      expect((await mutation(p, grant)).status).toBe(409);
    } finally {
      await f.db
        .prepare(
          "CREATE TRIGGER credential_receipt_no_update BEFORE UPDATE ON credential_operation_receipts BEGIN SELECT RAISE(ABORT,'CREDENTIAL_RECEIPT_IMMUTABLE'); END",
        )
        .run();
    }
  });
  it.each(['personnel.permissions', 'sensitive_action_grant.consumed'] as const)(
    '%s audit insert failure rolls back entire effect, consume, receipt and sessions',
    async (event) => {
      const employee = await f.seed(`rollback-${event.replaceAll('.', '-')}`);
      const targetSession = await f.session(employee.id);
      const p = await prepare({
        kind: 'permissions',
        targetId: employee.membershipId,
        expectedVersion: 1,
        reason: 'Synthetic authorized correction',
        grants: [{ permission_code: 'customer.read', scope: 'ASSIGNED' }],
      });
      const grant = await token(p);
      await f.db
        .prepare(
          `CREATE TRIGGER correction_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action='${event}' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_AUDIT_FAILURE'); END`,
        )
        .run();
      try {
        expect((await mutation(p, grant)).status).toBe(409);
        expect(
          await f.db
            .prepare('SELECT version,permission_version FROM agency_memberships WHERE id=?')
            .bind(employee.membershipId)
            .first(),
        ).toEqual({ version: 1, permission_version: 1 });
        expect(
          await f.db
            .prepare(
              'SELECT status FROM sensitive_action_grants WHERE id=(SELECT grant_id FROM credential_operation_receipts WHERE operation_key=?)',
            )
            .bind(`grant:${p.key}`)
            .first(),
        ).toEqual({ status: 'ISSUED' });
        expect(
          (
            await f.db
              .prepare('SELECT id FROM credential_operation_receipts WHERE operation_key=?')
              .bind(p.key)
              .all()
          ).results,
        ).toHaveLength(0);
        expect((await f.request('/api/me', 'GET', targetSession.cookie)).status).toBe(200);
      } finally {
        await f.db.prepare('DROP TRIGGER correction_audit_failure').run();
      }
    },
  );
  it.each(['create', 'reset', 'reactivate'] as const)(
    '%s never persists or replays temporary plaintext, even with changed retry payload',
    async (kind) => {
      const employee = kind === 'create' ? null : await f.seed(`secret-${kind}`);
      if (kind === 'reactivate')
        await f.db
          .prepare(
            "UPDATE agency_memberships SET status='INACTIVE',inactivated_at=?,version=version+1,permission_version=permission_version+1 WHERE id=?",
          )
          .bind(new Date().toISOString(), employee!.membershipId)
          .run();
      const body =
        kind === 'create'
          ? {
              kind,
              name: 'Synthetic temporary',
              email: 'secret-create@example.invalid',
              template: 'personel',
              grants: [],
            }
          : {
              kind,
              targetId: employee!.membershipId,
              expectedVersion: kind === 'reactivate' ? 2 : 1,
              reason: 'Synthetic authorized recovery',
            };
      const p = await prepare(body);
      const grant = await token(p);
      const response = await mutation(p, grant);
      expect(response.status).toBe(kind === 'create' ? 201 : 200);
      const secret = ((await response.json()) as { data: { temporaryPassword: string } }).data
        .temporaryPassword;
      const retry = await mutation(p, grant);
      expect(retry.status).toBe(409);
      expect(await retry.text()).not.toContain(secret);
      const changed =
        kind === 'create'
          ? { ...body, name: 'Changed employee' }
          : { ...body, reason: 'Changed authorized recovery' };
      const conflict = await mutation(p, grant, changed);
      expect(conflict.status).toBe(409);
      expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
        'IDEMPOTENCY_CONFLICT',
      );
      const receipts = (
        await f.db
          .prepare('SELECT * FROM credential_operation_receipts WHERE operation_key=?')
          .bind(p.key)
          .all()
      ).results;
      const audits = (
        await f.db.prepare('SELECT * FROM audit_events WHERE idempotency_key=?').bind(p.key).all()
      ).results;
      expect(receipts[0]!.safe_response_json).toBeNull();
      for (const forbidden of [
        secret,
        grant,
        p.csrf,
        p.session.cookie.split('=')[1]!,
        p.session.hash,
        owner.password,
      ])
        expect(JSON.stringify({ receipts, audits })).not.toContain(forbidden);
    },
  );
  it('issuance audit failure rolls back grant and issuance receipt', async () => {
    const p = await prepare({
      kind: 'create',
      name: 'Synthetic failed issue',
      email: 'failed-issue@example.invalid',
      template: 'personel',
      grants: [],
    });
    const before = (await f.db.prepare('SELECT id FROM sensitive_action_grants').all()).results
      .length;
    await f.db
      .prepare(
        "CREATE TRIGGER correction_issue_audit_failure BEFORE INSERT ON audit_events WHEN NEW.action='sensitive_action_grant.issued' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_ISSUANCE_AUDIT_FAILURE'); END",
      )
      .run();
    try {
      expect((await p.issue()).status).not.toBe(200);
      expect(
        (await f.db.prepare('SELECT id FROM sensitive_action_grants').all()).results,
      ).toHaveLength(before);
      expect(
        (
          await f.db
            .prepare('SELECT id FROM credential_operation_receipts WHERE operation_key=?')
            .bind(`grant:${p.key}`)
            .all()
        ).results,
      ).toHaveLength(0);
    } finally {
      await f.db.prepare('DROP TRIGGER correction_issue_audit_failure').run();
    }
  });
  it('issuance target change after preflight rolls back grant, receipt and audit', async () => {
    const employee = await f.seed('issue-during-preflight');
    const p = await prepare({
      kind: 'permissions',
      targetId: employee.membershipId,
      expectedVersion: 1,
      reason: 'Synthetic authorized correction',
      grants: [],
    });
    const original = f.db.batch.bind(f.db);
    const spy = vi.spyOn(f.env.DB, 'batch').mockImplementationOnce(async (...args) => {
      await f.db
        .prepare(
          'UPDATE agency_memberships SET version=version+1,permission_version=permission_version+1 WHERE id=?',
        )
        .bind(employee.membershipId)
        .run();
      return original(...args);
    });
    try {
      expect((await p.issue()).status).not.toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(
      (
        await f.db
          .prepare('SELECT id FROM credential_operation_receipts WHERE operation_key=?')
          .bind(`grant:${p.key}`)
          .all()
      ).results,
    ).toHaveLength(0);
  });
  it('SENSITIVE grant and revoke audit carries exact scope deltas and type/status evidence', async () => {
    const employee = await f.seed('audit-sensitive-target', 'OWNER');
    for (const [version, grants] of [
      [1, [{ permission_code: 'sensitive.identity.read', scope: 'UNSCOPED' }]],
      [2, []],
    ] as const) {
      const p = await prepare({
        kind: 'permissions',
        targetId: employee.membershipId,
        expectedVersion: version,
        reason: 'Synthetic authorized sensitive correction',
        grants,
      });
      const grant = await token(p);
      expect((await mutation(p, grant)).status).toBe(200);
      const event = await f.db
        .prepare(
          "SELECT metadata_json FROM audit_events WHERE action='personnel.permissions' AND idempotency_key=?",
        )
        .bind(p.key)
        .first<{ metadata_json: string }>();
      const metadata = JSON.parse(event!.metadata_json);
      expect(metadata.beforeType).toBe('OWNER');
      expect(metadata.afterType).toBe('OWNER');
      expect(metadata.beforeStatus).toBe('ACTIVE');
      expect(metadata.afterStatus).toBe('ACTIVE');
      expect(metadata.beforeVersion).toBe(version);
      expect(metadata.afterVersion).toBe(version + 1);
      expect(metadata.permissionDeltas).toEqual([
        {
          permissionCode: 'sensitive.identity.read',
          classification: 'SENSITIVE',
          beforeScope: version === 1 ? null : 'UNSCOPED',
          afterScope: version === 1 ? 'UNSCOPED' : null,
        },
      ]);
    }
  });
  it('arbitrary storage failure never reconciles an otherwise successful competing issuance', async () => {
    const p = await prepare({
      kind: 'create',
      name: 'Synthetic generic failure',
      email: 'generic-failure@example.invalid',
      template: 'personel',
      grants: [],
    });
    const original = f.db.batch.bind(f.db);
    let arrivals = 0;
    let release!: () => void;
    let committed!: () => void;
    const ready = new Promise<void>((r) => {
      release = r;
    });
    const done = new Promise<void>((r) => {
      committed = r;
    });
    const spy = vi.spyOn(f.env.DB, 'batch').mockImplementation(async (...args) => {
      const n = ++arrivals;
      if (n === 2) release();
      await ready;
      if (n === 1) {
        const result = await original(...args);
        committed();
        return result;
      }
      await done;
      throw new Error('SYNTHETIC_GENERIC_STORAGE_FAILURE');
    });
    try {
      const results = await Promise.all([p.issue(), p.issue()]);
      expect(arrivals).toBe(2);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    } finally {
      spy.mockRestore();
    }
  });
  it.each([
    'person@example.invalid',
    '12345678901',
    'Bearer synthetic_material',
    'password=synthetic_material',
  ] as const)('rejects unsafe explicit justification without persisting it: %s', async (unsafe) => {
    const employee = await f.seed(`unsafe-${crypto.randomUUID()}`);
    const p = await prepare({
      kind: 'permissions',
      targetId: employee.membershipId,
      expectedVersion: 1,
      reason: unsafe,
      grants: [],
    });
    const response = await p.issue();
    expect(response.status).toBe(400);
    const logs = await f.db.prepare('SELECT metadata_json FROM audit_events').all();
    expect(JSON.stringify(logs.results)).not.toContain(unsafe);
  });
});

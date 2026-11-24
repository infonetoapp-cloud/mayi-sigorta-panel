// @vitest-environment node
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createFullPersonnelGrants, FULL_PERSONNEL_TEMPLATE } from '../src/shared/permissions';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: Awaited<ReturnType<typeof f.seed>>;
beforeAll(async () => {
  f = await localAuthFixture();
  owner = await f.seed('personnel-owner', 'OWNER');
});
afterAll(async () => {
  await f?.mf.dispose();
});
async function command(cookie: string, body: unknown, key = crypto.randomUUID()) {
  const csrf = await f.csrf(cookie);
  const grant = await f.request('/secure/api/personnel/grants', 'POST', cookie, body, csrf, {
    'idempotency-key': `grant-${key}`,
  });
  if (grant.status !== 200) return grant;
  const token = ((await grant.json()) as { data: { grantEvidenceToken: string } }).data
    .grantEvidenceToken;
  return f.request(
    '/secure/api/personnel/commands',
    'POST',
    cookie,
    { command: body, grantEvidenceToken: token },
    csrf,
    { 'idempotency-key': key },
  );
}
describe('F-27 personnel atomic commands', () => {
  it('OWNER can grant and revoke explicit SENSITIVE-only permissions with implicit NORMAL dependencies', async () => {
    const coowner = await f.seed('sensitive-coowner', 'OWNER');
    const session = await f.session(owner.id, true);
    const grants = [
      { permission_code: 'sensitive.identity.read', scope: 'UNSCOPED' },
      { permission_code: 'sensitive.identity.write', scope: 'UNSCOPED' },
    ];
    try {
      expect(
        (
          await command(session.cookie, {
            kind: 'permissions',
            targetId: coowner.membershipId,
            expectedVersion: 1,
            reason: 'Synthetic sensitive grant',
            grants,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await command(session.cookie, {
            kind: 'permissions',
            targetId: coowner.membershipId,
            expectedVersion: 2,
            reason: 'Synthetic sensitive revoke',
            grants: [],
          })
        ).status,
      ).toBe(200);
    } finally {
      await f.db
        .prepare(
          "UPDATE agency_memberships SET type='MEMBER',version=version+1,permission_version=permission_version+1 WHERE id=?",
        )
        .bind(coowner.membershipId)
        .run();
    }
  });
  it('paginates every employee beyond the first 100 and only returns page grants', async () => {
    const session = await f.session(owner.id);
    await f.db.batch(
      Array.from({ length: 105 }, (_, n) =>
        f.db
          .prepare("INSERT INTO users(id,status,display_name) VALUES(?,'ACTIVE',?)")
          .bind(`page-user-${n}`, `Synthetic page ${n}`),
      ),
    );
    await f.db.batch(
      Array.from({ length: 105 }, (_, n) =>
        f.db
          .prepare(
            "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at,activated_at) VALUES(?,?,?,'MEMBER','ACTIVE',?,'2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
          )
          .bind(
            `page-member-${String(n).padStart(3, '0')}`,
            owner.agencyId,
            `page-user-${n}`,
            `page-${n}@example.invalid`,
          ),
      ),
    );
    const ids = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await f.request(
        `/api/personnel?page_size=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        'GET',
        session.cookie,
      );
      expect(response.status).toBe(200);
      const data = (
        (await response.json()) as {
          data: { personnel: { id: string }[]; nextCursor: string | null };
        }
      ).data;
      expect(data.personnel.length).toBeLessThanOrEqual(25);
      data.personnel.forEach((p) => {
        expect(ids.has(p.id)).toBe(false);
        ids.add(p.id);
      });
      cursor = data.nextCursor;
    } while (cursor);
    expect([...ids].filter((id) => id.startsWith('page-member-')).length).toBe(105);
  });
  it('normal session cannot issue high-risk grants; MEMBER cannot create or reset', async () => {
    const normal = await f.session(owner.id);
    expect(
      (
        await command(normal.cookie, {
          kind: 'create',
          name: 'Synthetic Employee',
          email: 'no-create@example.invalid',
          template: 'personel',
          grants: [],
        })
      ).status,
    ).toBe(401);
    const member = await f.seed('actor-member');
    const session = await f.session(member.id, true);
    expect(
      (
        await command(session.cookie, {
          kind: 'create',
          name: 'Synthetic Employee',
          email: 'no-create@example.invalid',
          template: 'personel',
          grants: [],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.db
          .prepare(
            "SELECT action,outcome,metadata_json FROM audit_events WHERE actor_user_id=? AND action='personnel.denied'",
          )
          .bind(member.id)
          .all()
      ).results.length,
    ).toBe(1);
  });
  it('creates native identity, snapshot grants and one-time temp; replay never discloses it', async () => {
    const session = await f.session(owner.id, true);
    const csrf = await f.csrf(session.cookie);
    const key = crypto.randomUUID();
    const payload = {
      kind: 'create',
      name: 'Synthetic Employee',
      email: '  NEW.EMPLOYEE@EXAMPLE.INVALID ',
      template: 'personel',
      grants: [{ permission_code: 'customer.read', scope: 'ASSIGNED' }],
    };
    const grantResponse = await f.request(
      '/secure/api/personnel/grants',
      'POST',
      session.cookie,
      payload,
      csrf,
      { 'idempotency-key': `grant-${key}` },
    );
    expect(grantResponse.status).toBe(200);
    const grant = ((await grantResponse.json()) as { data: { grantEvidenceToken: string } }).data
      .grantEvidenceToken;
    const body = { command: payload, grantEvidenceToken: grant };
    const result = await f.request(
      '/secure/api/personnel/commands',
      'POST',
      session.cookie,
      body,
      csrf,
      { 'idempotency-key': key },
    );
    expect(result.status).toBe(201);
    const data = (
      (await result.json()) as {
        data: { userId: string; temporaryPassword: string; membershipId: string };
      }
    ).data;
    expect(typeof data.temporaryPassword === 'string').toBe(true);
    const retry = await f.request(
      '/secure/api/personnel/commands',
      'POST',
      session.cookie,
      body,
      csrf,
      { 'idempotency-key': key },
    );
    expect(retry.status).toBe(409);
    expect((await retry.text()).includes(data.temporaryPassword)).toBe(false);
    const persisted = await f.db
      .prepare('SELECT * FROM audit_events UNION ALL SELECT * FROM audit_events WHERE 0')
      .all();
    expect(JSON.stringify(persisted.results).includes(data.temporaryPassword)).toBe(false);
    const receipts = await f.db.prepare('SELECT * FROM credential_operation_receipts').all();
    expect(JSON.stringify(receipts.results).includes(data.temporaryPassword)).toBe(false);
    const login = await f.request('/api/auth/login', 'POST', undefined, {
      email: 'new.employee@example.invalid',
      password: data.temporaryPassword,
    });
    expect(login.status).toBe(200);
    expect(((await login.json()) as { data: { state: string } }).data.state).toBe('ACTIVATION');
    const identity = await f.db
      .prepare(
        'SELECT i.issuer,i.subject,i.email_provenance FROM auth_identities i WHERE i.user_id=?',
      )
      .bind(data.userId)
      .first<{ issuer: string; subject: string; email_provenance: string }>();
    expect(identity?.issuer).toBe('urn:mayisigorta:local-auth:v1');
    expect(identity?.email_provenance).toBe('OWNER_PROVISIONED');
    expect(identity?.subject === 'new.employee@example.invalid').toBe(false);
  });
  it('provisions the complete grant snapshot and keeps personnel creation owner-only', async () => {
    const session = await f.session(owner.id, true);
    const grants = createFullPersonnelGrants();
    const payload = {
      kind: 'create',
      name: 'Synthetic Full Employee',
      email: 'full.employee@example.invalid',
      template: FULL_PERSONNEL_TEMPLATE,
      grants,
    };
    expect((await command(session.cookie, { ...payload, grants: [] })).status).toBe(400);
    const created = await command(session.cookie, payload);
    expect(created.status, await created.clone().text()).toBe(201);
    const { data } = (await created.json()) as { data: { membershipId: string } };
    const stored = await f.db
      .prepare('SELECT permission_code,scope FROM membership_permissions WHERE membership_id=?')
      .bind(data.membershipId)
      .all<{ permission_code: string; scope: string }>();
    expect(stored.results).toHaveLength(grants.length);
    expect(stored.results).toEqual(expect.arrayContaining(grants));
    expect(grants).toContainEqual({ permission_code: 'sensitive.health.read', scope: 'UNSCOPED' });
    expect(grants).toContainEqual({ permission_code: 'task.read', scope: 'ASSIGNED' });

    const actor = await f.seed('full-member-denied');
    await f.db
      .prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
        SELECT lower(hex(randomblob(16))),?,permission_code,scope FROM membership_permissions WHERE membership_id=?`,
      )
      .bind(actor.membershipId, data.membershipId)
      .run();
    const member = await f.session(actor.id, true);
    const denied = await command(member.cookie, { ...payload, email: 'blocked@example.invalid' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: 'OWNER_REQUIRED' } });
  });
  it('reset revokes every target session while preserving inactive status and permissions', async () => {
    const employee = await f.seed('reset-employee');
    const active = await f.session(employee.id);
    const ownerSession = await f.session(owner.id, true);
    await f.db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'customer.read','ASSIGNED')",
      )
      .bind(crypto.randomUUID(), employee.membershipId)
      .run();
    const before = await f.db
      .prepare('SELECT permission_code,scope FROM membership_permissions WHERE membership_id=?')
      .bind(employee.membershipId)
      .all();
    const inactivate = await command(ownerSession.cookie, {
      kind: 'inactivate',
      targetId: employee.membershipId,
      expectedVersion: 1,
      reason: 'Synthetic offboarding',
    });
    expect(inactivate.status).toBe(200);
    expect((await f.request('/api/me', 'GET', active.cookie)).status).toBe(401);
    const reset = await command(ownerSession.cookie, {
      kind: 'reset',
      targetId: employee.membershipId,
      expectedVersion: 2,
      reason: 'Synthetic credential recovery',
    });
    expect(reset.status).toBe(200);
    const data = ((await reset.json()) as { data: { temporaryPassword: string } }).data;
    const state = await f.db
      .prepare('SELECT status,permission_version FROM agency_memberships WHERE id=?')
      .bind(employee.membershipId)
      .first();
    expect(state).toEqual({ status: 'INACTIVE', permission_version: 2 });
    expect(
      (
        await f.db
          .prepare('SELECT permission_code,scope FROM membership_permissions WHERE membership_id=?')
          .bind(employee.membershipId)
          .all()
      ).results,
    ).toEqual(before.results);
    expect(
      (
        await f.request('/api/auth/login', 'POST', undefined, {
          email: employee.email,
          password: data.temporaryPassword,
        })
      ).status,
    ).toBe(401);
    const reactivated = await command(ownerSession.cookie, {
      kind: 'reactivate',
      targetId: employee.membershipId,
      expectedVersion: 3,
      reason: 'Synthetic reactivation',
    });
    expect(reactivated.status).toBe(200);
    const fresh = ((await reactivated.json()) as { data: { temporaryPassword: string } }).data
      .temporaryPassword;
    expect(fresh === data.temporaryPassword).toBe(false);
    expect(
      (
        await f.request('/api/auth/login', 'POST', undefined, {
          email: employee.email,
          password: data.temporaryPassword,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.request('/api/auth/login', 'POST', undefined, {
          email: employee.email,
          password: fresh,
        })
      ).status,
    ).toBe(200);
  });
  it('last owner mutation rolls back grant, credential, membership and audit', async () => {
    const session = await f.session(owner.id, true);
    const current = await f.db
      .prepare('SELECT version FROM agency_memberships WHERE id=?')
      .bind(owner.membershipId)
      .first<{ version: number }>();
    const before = (await f.db.prepare('SELECT id FROM audit_events').all()).results.length;
    const result = await command(session.cookie, {
      kind: 'inactivate',
      targetId: owner.membershipId,
      expectedVersion: current!.version,
      reason: 'Synthetic last owner denial',
    });
    expect(result.status).toBe(409);
    expect(
      (
        await f.db
          .prepare('SELECT status FROM agency_memberships WHERE id=?')
          .bind(owner.membershipId)
          .first<{ status: string }>()
      )?.status,
    ).toBe('ACTIVE');
    expect((await f.request('/api/me', 'GET', session.cookie)).status).toBe(200);
    expect(
      (
        await f.db
          .prepare(
            "SELECT id FROM audit_events WHERE action='personnel.inactivate' AND target_id=?",
          )
          .bind(owner.id)
          .all()
      ).results.length,
    ).toBe(0);
    expect((await f.db.prepare('SELECT id FROM audit_events').all()).results.length).toBe(
      before + 2,
    );
  });
  it('sole LOCAL OWNER reset preserves effective-owner state and only allows forced activation', async () => {
    const session = await f.session(owner.id, true);
    const row = await f.db
      .prepare('SELECT version FROM agency_memberships WHERE id=?')
      .bind(owner.membershipId)
      .first<{ version: number }>();
    const response = await command(session.cookie, {
      kind: 'reset',
      targetId: owner.membershipId,
      expectedVersion: row!.version,
      reason: 'Synthetic owner credential recovery',
    });
    expect(response.status).toBe(200);
    const data = ((await response.json()) as { data: { temporaryPassword: string } }).data;
    expect((await f.request('/api/me', 'GET', session.cookie)).status).toBe(401);
    expect(
      await f.db
        .prepare('SELECT type,status FROM agency_memberships WHERE id=?')
        .bind(owner.membershipId)
        .first(),
    ).toEqual({ type: 'OWNER', status: 'ACTIVE' });
    const login = await f.request('/api/auth/login', 'POST', undefined, {
      email: owner.email,
      password: data.temporaryPassword,
    });
    expect(login.status).toBe(200);
    const activationCookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(((await login.json()) as { data: { state: string } }).data.state).toBe('ACTIVATION');
    const csrf = await f.csrf(activationCookie);
    const activation = await f.request(
      '/api/auth/password',
      'POST',
      activationCookie,
      {
        newPassword: 'synthetic recovered owner winter phrase',
        confirmation: 'synthetic recovered owner winter phrase',
      },
      csrf,
    );
    expect(activation.status).toBe(200);
    expect(
      (await f.request('/api/me', 'GET', activation.headers.get('set-cookie')!.split(';')[0]!))
        .status,
    ).toBe(200);
  });
});

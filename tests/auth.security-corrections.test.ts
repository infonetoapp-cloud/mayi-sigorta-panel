// @vitest-environment node
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('correction-root', 'OWNER');
});
afterAll(async () => {
  await f?.mf.dispose();
});
describe('HIGH corrections: native login membership selection', () => {
  it.each(['INACTIVE', 'SUSPENDED', 'PROVISIONING'] as const)(
    'ignores unrelated %s history before active ambiguity count',
    async (history) => {
      const user = await f.seed(`history-${history.toLowerCase()}`);
      const agency = `history-agency-${history}`;
      if (history === 'PROVISIONING')
        await f.db
          .prepare("INSERT INTO agencies(id,status) VALUES(?,'PROVISIONING')")
          .bind(agency)
          .run();
      else await f.seed(`history-owner-${history.toLowerCase()}`, 'OWNER', false, agency);
      await f.db
        .prepare(
          "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at,activated_at,suspended_at,inactivated_at) VALUES(?,?,?, ?,?,'synthetic@example.invalid','2099-01-01T00:00:00.000Z',?, ?,?)",
        )
        .bind(
          `history-link-${history}`,
          agency,
          user.id,
          history === 'PROVISIONING' ? 'OWNER' : 'MEMBER',
          history === 'PROVISIONING' ? 'INVITED' : history,
          history === 'PROVISIONING' ? null : '2026-01-01T00:00:00.000Z',
          history === 'SUSPENDED' ? '2026-01-01T00:00:00.000Z' : null,
          history === 'INACTIVE' ? '2026-01-01T00:00:00.000Z' : null,
        )
        .run();
      if (history === 'PROVISIONING')
        await f.db
          .prepare(
            "UPDATE agency_memberships SET status='ACTIVE',activated_at=?,version=version+1,permission_version=permission_version+1 WHERE id=?",
          )
          .bind(new Date().toISOString(), `history-link-${history}`)
          .run();
      const before = f.hasher.calls;
      const result = await f.request('/api/auth/login', 'POST', undefined, {
        email: `  ${user.email.toUpperCase()}  `,
        password: user.password,
      });
      expect(result.status).toBe(200);
      expect(f.hasher.calls - before).toBe(1);
    },
  );
  it.each(['zero', 'multiple'] as const)(
    'denies %s ACTIVE candidates generically with dummy KDF',
    async (mode) => {
      const user = await f.seed(`ambiguity-${mode}`);
      if (mode === 'zero')
        await f.db
          .prepare(
            "UPDATE agency_memberships SET status='INACTIVE',inactivated_at='2026-01-01T00:00:00.000Z',version=version+1,permission_version=permission_version+1 WHERE id=?",
          )
          .bind(user.membershipId)
          .run();
      else {
        const agency = 'ambiguity-agency';
        await f.seed('ambiguity-owner', 'OWNER', false, agency);
        await f.db
          .prepare(
            "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at,activated_at) VALUES(?,?,?,'MEMBER','ACTIVE','synthetic@example.invalid','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
          )
          .bind('ambiguity-link', agency, user.id)
          .run();
      }
      const before = f.hasher.calls;
      const result = await f.request('/api/auth/login', 'POST', undefined, {
        email: user.email,
        password: user.password,
      });
      expect(result.status).toBe(401);
      expect(((await result.json()) as { error: { code: string } }).error.code).toBe(
        'LOGIN_FAILED',
      );
      expect(f.hasher.calls - before).toBe(1);
    },
  );
});

// @vitest-environment node
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { LOCAL_AUTH_ISSUER } from '../src/server/auth/session';
import { fixturePasswordHasher as productionPasswordHasher } from './support/scrypt-fixture-hasher';
import { createApp } from '../src/server/index';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let nativeVerifier: string;
const nativePassword = 'synthetic native owner winter phrase';
beforeAll(async () => {
  f = await localAuthFixture();
  nativeVerifier = await productionPasswordHasher.hash(nativePassword);
});
afterAll(async () => {
  await f?.mf.dispose();
});
async function legacyOwner(id: string, agencyId = `agency-${id}`) {
  const exists = await f.db.prepare('SELECT id FROM agencies WHERE id=?').bind(agencyId).first();
  if (!exists)
    await f.db
      .prepare("INSERT INTO agencies(id,status) VALUES(?,'PROVISIONING')")
      .bind(agencyId)
      .run();
  await f.db.prepare("INSERT INTO users(id,status) VALUES(?,'ACTIVE')").bind(id).run();
  await f.db
    .prepare(
      "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email) VALUES(?,?,'https://synthetic.cloudflareaccess.com',?,?)",
    )
    .bind(`legacy-${id}`, id, `legacy-subject-${id}`, `${id}@example.invalid`)
    .run();
  await f.db
    .prepare(
      "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at,activated_at) VALUES(?,?,?,'OWNER',?,?,'2099-01-01T00:00:00.000Z',?)",
    )
    .bind(
      `member-${id}`,
      agencyId,
      id,
      exists ? 'ACTIVE' : 'INVITED',
      `${id}@example.invalid`,
      exists ? new Date().toISOString() : null,
    )
    .run();
  if (!exists) {
    await f.db
      .prepare(
        "UPDATE agency_memberships SET status='ACTIVE',activated_at=?,version=version+1,permission_version=permission_version+1 WHERE id=?",
      )
      .bind(new Date().toISOString(), `member-${id}`)
      .run();
    await f.db
      .prepare(
        "UPDATE agencies SET status='ACTIVE',activated_at=?,bootstrap_completed_at=?,version=version+1 WHERE id=?",
      )
      .bind(new Date().toISOString(), new Date().toISOString(), agencyId)
      .run();
  }
  return { id, identityId: `legacy-${id}`, membershipId: `member-${id}`, agencyId };
}
async function mixedOwner(id: string, legacyCoowner = false) {
  const user = await f.seed(id, 'OWNER', false, `agency-${id}`);
  await f.db
    .prepare('UPDATE local_credentials SET verifier=? WHERE user_id=?')
    .bind(nativeVerifier, user.id)
    .run();
  await f.db
    .prepare(
      "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email) VALUES(?,?,'https://synthetic.cloudflareaccess.com',?,?)",
    )
    .bind(`legacy-${id}`, id, `legacy-subject-${id}`, user.email)
    .run();
  if (legacyCoowner) await legacyOwner(`${id}-legacy-backup`, user.agencyId);
  return user;
}
async function denied(sql: string, values: (string | number | null)[] = []) {
  const rejected = await f.db
    .prepare(sql)
    .bind(...values)
    .run()
    .then(
      () => false,
      () => true,
    );
  expect(rejected).toBe(true); // Never print verifier/cookie/temporary material on assertion failure.
}
async function enabled(userId: string) {
  return (
    await f.db
      .prepare('SELECT login_enabled FROM local_credentials WHERE user_id=?')
      .bind(userId)
      .first<{ login_enabled: number }>()
  )?.login_enabled;
}
describe('effective LOCAL owner guards on native D1 with preserved historical identities', () => {
  it('rejects sole local identity revocation despite a second ACTIVE legacy identity for the same User', async () => {
    const user = await mixedOwner('mixed-parent-repro');
    await denied(
      "UPDATE auth_identities SET status='REVOKED',revoked_at=?,version=version+1 WHERE id=?",
      [new Date().toISOString(), user.identityId],
    );
    expect(await enabled(user.id)).toBe(1);
    f.env.PASSWORD_KDF = { getByName: () => productionPasswordHasher } as never;
    const app = createApp();
    const login = await app.fetch(
      new Request('https://panel.mayisigorta.com/api/auth/login', {
        method: 'POST',
        headers: { origin: 'https://panel.mayisigorta.com', 'content-type': 'application/json' },
        body: JSON.stringify({ email: user.email, password: nativePassword }),
      }),
      f.env,
    );
    expect(login.status).toBe(200);
    expect(
      (
        await f.db
          .prepare('SELECT count(*) n FROM auth_identities WHERE user_id=?')
          .bind(user.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });
  it('does not count another legacy-only OWNER when revoking the last LOCAL identity', async () => {
    const user = await mixedOwner('mixed-legacy-only', true);
    await denied(
      "UPDATE auth_identities SET status='REVOKED',revoked_at=?,version=version+1 WHERE id=?",
      [new Date().toISOString(), user.identityId],
    );
    expect(await enabled(user.id)).toBe(1);
  });
  it.each(['demote', 'suspend', 'inactivate'] as const)(
    'rejects last-local-owner membership %s despite legacy-only coowner',
    async (kind) => {
      const user = await mixedOwner(`mixed-${kind}`, true);
      const sql =
        kind === 'demote'
          ? "UPDATE agency_memberships SET type='MEMBER',version=version+1,permission_version=permission_version+1 WHERE id=?"
          : `UPDATE agency_memberships SET status='${kind === 'suspend' ? 'SUSPENDED' : 'INACTIVE'}',${kind === 'suspend' ? 'suspended_at' : 'inactivated_at'}=?,version=version+1,permission_version=permission_version+1 WHERE id=?`;
      await denied(
        sql,
        kind === 'demote' ? [user.membershipId] : [new Date().toISOString(), user.membershipId],
      );
      expect(await enabled(user.id)).toBe(1);
      expect(
        await f.db
          .prepare('SELECT type,status FROM agency_memberships WHERE id=?')
          .bind(user.membershipId)
          .first(),
      ).toEqual({ type: 'OWNER', status: 'ACTIVE' });
    },
  );
  it('rejects last LOCAL User inactivation even with a legacy-only coowner', async () => {
    const user = await mixedOwner('mixed-user', true);
    await denied("UPDATE users SET status='INACTIVE',version=version+1 WHERE id=?", [user.id]);
    expect(await enabled(user.id)).toBe(1);
  });
  it('rejects credential disable and deletion even without a session FK', async () => {
    const user = await mixedOwner('mixed-credential', true);
    await denied(
      'UPDATE local_credentials SET login_enabled=0,credential_version=credential_version+1 WHERE user_id=?',
      [user.id],
    );
    await denied('DELETE FROM local_credentials WHERE user_id=?', [user.id]);
    expect(await enabled(user.id)).toBe(1);
  });
  it.each(['id', 'user_id', 'issuer', 'subject', 'verified_email', 'email_provenance'] as const)(
    'keeps credential-bound LOCAL identity %s immutable',
    async (field) => {
      const user = await mixedOwner(`mixed-binding-${field}`, true);
      const value =
        field === 'email_provenance'
          ? 'LEGACY_EXTERNAL'
          : field === 'verified_email'
            ? 'different@example.invalid'
            : field === 'issuer'
              ? 'https://synthetic.cloudflareaccess.com'
              : `changed-${field}`;
      await denied(`UPDATE auth_identities SET ${field}=?,version=version+1 WHERE id=?`, [
        value,
        user.identityId,
      ]);
      expect(await enabled(user.id)).toBe(1);
    },
  );
  it('preserves membership/user/identity/agency immutable binding and hard-delete guards', async () => {
    const user = await mixedOwner('mixed-delete', true);
    for (const sql of [
      'DELETE FROM agency_memberships WHERE id=?',
      "UPDATE agency_memberships SET agency_id='different-agency',version=version+1 WHERE id=?",
      "UPDATE agency_memberships SET user_id='different-user',version=version+1 WHERE id=?",
    ])
      await denied(sql, [user.membershipId]);
    await denied('DELETE FROM users WHERE id=?', [user.id]);
    await denied("UPDATE users SET id='different-user',version=version+1 WHERE id=?", [user.id]);
    await denied('DELETE FROM auth_identities WHERE id=?', [user.identityId]);
    await denied('DELETE FROM agencies WHERE id=?', [user.agencyId]);
    expect(await enabled(user.id)).toBe(1);
  });
  it('rejects credential row replacement that could erase another local OWNER', async () => {
    const user = await mixedOwner('mixed-replace', true);
    const other = await f.seed('mixed-replace-member', 'MEMBER', false, user.agencyId);
    await denied(
      'INSERT OR REPLACE INTO local_credentials(user_id,identity_id,login_email,verifier,must_change_password,temporary_expires_at,updated_at) SELECT user_id,identity_id,?,verifier,must_change_password,temporary_expires_at,updated_at FROM local_credentials WHERE user_id=?',
      [user.email, other.id],
    );
    await denied(
      'INSERT OR REPLACE INTO local_credentials(user_id,identity_id,login_email,verifier,must_change_password,temporary_expires_at,login_enabled,updated_at) SELECT user_id,identity_id,login_email,verifier,must_change_password,temporary_expires_at,0,updated_at FROM local_credentials WHERE user_id=?',
      [user.id],
    );
    expect(await enabled(user.id)).toBe(1);
  });
  it('allows a valid LOCAL coowner reduction and normal MEMBER offboarding', async () => {
    const user = await mixedOwner('mixed-valid-coowner', true);
    const other = await f.seed('mixed-valid-coowner-backup', 'OWNER', false, user.agencyId);
    await f.db
      .prepare(
        "UPDATE auth_identities SET status='REVOKED',revoked_at=?,version=version+1 WHERE id=?",
      )
      .bind(new Date().toISOString(), user.identityId)
      .run();
    expect(await enabled(user.id)).toBe(0);
    expect(await enabled(other.id)).toBe(1);
    const member = await f.seed('mixed-offboard-member', 'MEMBER', false, user.agencyId);
    const session = await f.session(member.id);
    await f.db
      .prepare(
        "UPDATE agency_memberships SET status='INACTIVE',inactivated_at=?,version=version+1,permission_version=permission_version+1 WHERE id=?",
      )
      .bind(new Date().toISOString(), member.membershipId)
      .run();
    expect(await enabled(member.id)).toBe(0);
    expect((await f.request('/api/me', 'GET', session.cookie)).status).toBe(401);
    await denied('DELETE FROM local_credentials WHERE user_id=?', [member.id]);
  });
  it('allows promote-valid-local-before-reduce-old transfer and rejects reducing all local owners atomically', async () => {
    const user = await mixedOwner('mixed-transfer', true);
    const next = await f.seed('mixed-transfer-next', 'MEMBER', false, user.agencyId);
    await f.db.batch([
      f.db
        .prepare(
          "UPDATE agency_memberships SET type='OWNER',version=version+1,permission_version=permission_version+1 WHERE id=?",
        )
        .bind(next.membershipId),
      f.db
        .prepare(
          "UPDATE agency_memberships SET type='MEMBER',version=version+1,permission_version=permission_version+1 WHERE id=?",
        )
        .bind(user.membershipId),
    ]);
    expect(
      (
        await f.db
          .prepare('SELECT type FROM agency_memberships WHERE id=?')
          .bind(next.membershipId)
          .first<{ type: string }>()
      )?.type,
    ).toBe('OWNER');
    await f.db
      .prepare(
        "UPDATE agency_memberships SET type='OWNER',version=version+1,permission_version=permission_version+1 WHERE id=?",
      )
      .bind(user.membershipId)
      .run();
    await denied(
      "UPDATE agency_memberships SET type='MEMBER',version=version+1,permission_version=permission_version+1 WHERE id IN (?,?)",
      [user.membershipId, next.membershipId],
    );
    expect(
      (
        await f.db
          .prepare("SELECT count(*) n FROM agency_memberships WHERE id IN (?,?) AND type='OWNER'")
          .bind(user.membershipId, next.membershipId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });
  it('leaves pre-local legacy-only state and historical guard semantics intact', async () => {
    const user = await legacyOwner('mixed-historical-owner');
    await legacyOwner('mixed-historical-backup', user.agencyId);
    await f.db
      .prepare(
        "UPDATE auth_identities SET status='REVOKED',revoked_at=?,version=version+1 WHERE id=?",
      )
      .bind(new Date().toISOString(), user.identityId)
      .run();
    expect(
      (
        await f.db
          .prepare('SELECT count(*) n FROM local_credentials WHERE user_id=?')
          .bind(user.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      await f.db
        .prepare('SELECT issuer,email_provenance FROM auth_identities WHERE id=?')
        .bind(user.identityId)
        .first(),
    ).toEqual({
      issuer: 'https://synthetic.cloudflareaccess.com',
      email_provenance: 'LEGACY_EXTERNAL',
    });
    expect(LOCAL_AUTH_ISSUER).toBe('urn:mayisigorta:local-auth:v1');
  });
  it.each(['inactive', 'suspended', 'revoked'] as const)(
    'never counts a %s LOCAL coowner as the last owner replacement',
    async (state) => {
      const user = await mixedOwner(`mixed-unusable-${state}`, true);
      const other = await f.seed(`mixed-unusable-backup-${state}`, 'OWNER', false, user.agencyId);
      if (state === 'revoked')
        await f.db
          .prepare(
            "UPDATE auth_identities SET status='REVOKED',revoked_at=?,version=version+1 WHERE id=?",
          )
          .bind(new Date().toISOString(), other.identityId)
          .run();
      else
        await f.db
          .prepare(
            `UPDATE agency_memberships SET status='${state === 'inactive' ? 'INACTIVE' : 'SUSPENDED'}',${state === 'inactive' ? 'inactivated_at' : 'suspended_at'}=?,version=version+1,permission_version=permission_version+1 WHERE id=?`,
          )
          .bind(new Date().toISOString(), other.membershipId)
          .run();
      await denied(
        "UPDATE agency_memberships SET type='MEMBER',version=version+1,permission_version=permission_version+1 WHERE id=?",
        [user.membershipId],
      );
      expect(await enabled(user.id)).toBe(1);
      expect(await enabled(other.id)).toBe(0);
    },
  );
});

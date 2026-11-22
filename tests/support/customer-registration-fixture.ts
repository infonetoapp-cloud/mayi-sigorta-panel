import type { Env } from '../../src/server/index';

export async function seedRegistrationInsurer(db: D1Database, agencyId: string, id: string) {
  await db
    .prepare('INSERT INTO insurers(id,agency_id,code,name) VALUES(?,?,?,?)')
    .bind(id, agencyId, 'SYN_REGISTRATION', 'Sentetik Kayıt Sigortacısı')
    .run();
}

export function registrationNumber(insurerId: string) {
  return { insurerId, customerNumber: `00-${crypto.randomUUID()}` };
}

export async function enableCompanyRegistration(
  fixture: { db: D1Database; env: Env },
  membershipId: string,
) {
  const randomHex = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  fixture.env.IDENTITY_ENCRYPTION_KEY ??= randomHex();
  fixture.env.IDENTITY_HMAC_KEY ??= randomHex();
  fixture.env.IDENTITY_KEY_VERSION ??= '1';
  await fixture.db.batch(
    ['sensitive.identity.read', 'sensitive.identity.write'].map((permission) =>
      fixture.db
        .prepare(
          "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,'UNSCOPED')",
        )
        .bind(crypto.randomUUID(), membershipId, permission),
    ),
  );
}

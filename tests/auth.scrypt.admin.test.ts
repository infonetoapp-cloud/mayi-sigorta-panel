// @vitest-environment node
import { expect, it } from 'vitest';
import { administerLocalOwner, provisionInitialAgency } from '../src/server/auth/admin';
import { PasswordKdfService } from '../src/server/auth/password-kdf-service';
import { createDurableObjectPasswordHasher } from '../src/server/auth/password-do-adapter';
import { isSupportedPasswordVerifier } from '../src/server/auth/password-envelope';
import { localAuthFixture } from './support/local-auth-fixture';
it('default Node bootstrap and break-glass produce v2 accepted by serialized DO core after D1 text roundtrip', async () => {
  const f = await localAuthFixture();
  try {
    const base = {
      accountId: 'a'.repeat(32),
      databaseId: crypto.randomUUID(),
      agencyId: crypto.randomUUID(),
      operationKey: 'provision-' + crypto.randomUUID(),
    };
    await provisionInitialAgency(f.db, { ...base, mode: 'provision-agency' });
    const target = {
      ...base,
      ownerUserId: crypto.randomUUID(),
      email: crypto.randomUUID() + '@example.invalid',
      name: 'Synthetic Owner',
      operationKey: 'bootstrap-' + crypto.randomUUID(),
    };
    const service = new PasswordKdfService();
    const adapter = createDurableObjectPasswordHasher({ getByName: () => service });
    for (const mode of ['bootstrap', 'break-glass'] as const) {
      const result = await administerLocalOwner(f.db, {
        ...target,
        mode,
        operationKey: mode + '-' + crypto.randomUUID(),
      });
      const row = await f.db
        .prepare('SELECT verifier FROM local_credentials WHERE user_id=?')
        .bind(target.ownerUserId)
        .first<{ verifier: string }>();
      expect(isSupportedPasswordVerifier(row?.verifier)).toBe(true);
      const restored = JSON.parse(JSON.stringify({ verifier: row!.verifier })) as {
        verifier: string;
      };
      expect((await adapter.verify(result.temporaryPassword, restored.verifier)).matches).toBe(
        true,
      );
      expect(
        (await f.db.prepare('SELECT count(*) n FROM local_sessions').first<{ n: number }>())?.n,
      ).toBe(0);
    }
  } finally {
    await f.mf.dispose();
  }
}, 180000);

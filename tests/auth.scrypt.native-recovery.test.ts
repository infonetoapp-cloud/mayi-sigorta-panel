// @vitest-environment node
import { expect, it } from 'vitest';
import { createSyntheticAuthBackup } from '../scripts/recovery/local-auth-restore-proof';
import { restoreSyntheticAuthBackup } from '../scripts/recovery/local-auth-restore-proof';
import { administerLocalOwner, provisionInitialAgency } from '../src/server/auth/admin';
import { isSupportedPasswordVerifier } from '../src/server/auth/password-envelope';
import { openLocalKdfAdapter } from './support/local-kdf-runtime';
it('allows an explicit synthetic local seed before the existing native export boundary', async () => {
  let called = false;
  const create = createSyntheticAuthBackup as unknown as (
    seed: (db: D1Database) => Promise<void>,
  ) => ReturnType<typeof createSyntheticAuthBackup>;
  const source = await create(async () => {
    called = true;
  });
  try {
    expect(called).toBe(true);
  } finally {
    await source.dispose();
  }
}, 180000);

it('proves default admin bootstrap and break-glass through native backup restore and actual SQLite DO adapter', async () => {
  const runtime = await openLocalKdfAdapter();
  let source: Awaited<ReturnType<typeof createSyntheticAuthBackup>> | undefined;
  let restored: Awaited<ReturnType<typeof restoreSyntheticAuthBackup>> | undefined;
  let currentPassword = '';
  let currentVerifier = '';
  const base = {
    accountId: 'a'.repeat(32),
    databaseId: crypto.randomUUID(),
    agencyId: crypto.randomUUID(),
    operationKey: 'provision-' + crypto.randomUUID(),
  };
  const owner = {
    ...base,
    ownerUserId: crypto.randomUUID(),
    email: crypto.randomUUID() + '@example.invalid',
    name: 'Synthetic Owner',
  };
  try {
    source = await createSyntheticAuthBackup(async (db) => {
      await provisionInitialAgency(db, { ...base, mode: 'provision-agency' });
      for (const mode of ['bootstrap', 'break-glass'] as const) {
        const response = await administerLocalOwner(db, {
          ...owner,
          mode,
          operationKey: mode + '-' + crypto.randomUUID(),
        });
        const row = await db
          .prepare('SELECT verifier FROM local_credentials WHERE user_id=?')
          .bind(owner.ownerUserId)
          .first<{ verifier: string }>();
        expect(isSupportedPasswordVerifier(row?.verifier)).toBe(true);
        expect(
          (await runtime.hasher.verify(response.temporaryPassword, row!.verifier)).matches,
        ).toBe(true);
        currentPassword = response.temporaryPassword;
        currentVerifier = row!.verifier;
      }
    });
    expect(source.backup.artifactJson.includes(currentPassword)).toBe(false);
    restored = await restoreSyntheticAuthBackup(source.backup);
    expect(restored.report.code).toBe('VERIFIED_SEALED');
    const row = await restored.db
      .prepare('SELECT verifier FROM local_credentials WHERE user_id=?')
      .bind(owner.ownerUserId)
      .first<{ verifier: string }>();
    expect(row?.verifier === currentVerifier).toBe(true);
    expect(isSupportedPasswordVerifier(row?.verifier)).toBe(true);
    expect((await runtime.hasher.verify(currentPassword, row!.verifier)).matches).toBe(true);
    expect(restored.report.foreignKeys).toBe(0);
  } finally {
    await restored?.dispose();
    await source?.dispose();
    await runtime.dispose();
  }
}, 240000);

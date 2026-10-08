// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizePayload } from '../src/server/mutations/canonical';
import {
  createSyntheticAuthBackup,
  restoreSyntheticAuthBackup,
  SYNTHETIC_AUTH_TIME,
  type SyntheticAuthBackup,
  type AuthBackupArtifact,
} from '../scripts/recovery/local-auth-restore-proof';
import { createApp } from '../src/server/index';
import type { PasswordHasher } from '../src/server/auth/password';

let source: Awaited<ReturnType<typeof createSyntheticAuthBackup>>;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
beforeAll(async () => {
  source = await createSyntheticAuthBackup();
}, 180000);
afterAll(async () => {
  await source?.dispose();
});
function manifestChange(change: (b: SyntheticAuthBackup) => void) {
  const b = structuredClone(source.backup);
  change(b);
  b.manifestSha256 = sha(canonicalizePayload(b.manifest));
  return b;
}
function artifactChange(change: (a: AuthBackupArtifact) => void, rehashRows = false) {
  const b = structuredClone(source.backup),
    a = JSON.parse(b.artifactJson) as AuthBackupArtifact;
  change(a);
  for (const name of Object.keys(a.data))
    a.data[name] = a.data[name]!.map((r) => JSON.parse(canonicalizePayload(r))).sort((x, y) =>
      canonicalizePayload(x) < canonicalizePayload(y)
        ? -1
        : canonicalizePayload(x) > canonicalizePayload(y)
          ? 1
          : 0,
    );
  b.artifactJson = JSON.stringify(a);
  b.manifest.artifactSha256 = sha(b.artifactJson);
  if (rehashRows)
    for (const name of Object.keys(a.data)) {
      b.manifest.rowCounts[name] = a.data[name]!.length;
      b.manifest.fingerprints[name] = sha(JSON.stringify(a.data[name]));
    }
  b.manifestSha256 = sha(canonicalizePayload(b.manifest));
  return b;
}

it('restores populated synthetic F-27 auth into a fresh native D1 and stays sealed', async () => {
  const restored = await restoreSyntheticAuthBackup(source.backup);
  try {
    expect(restored.report.code).toBe('VERIFIED_SEALED');
    expect(restored.report.schemaHash).toBe(
      '335c292d19625658f789a09b9657730bb95a7db26bc5ac8b11f076d356a90a6f',
    );
    expect(restored.report.fingerprints).toEqual(source.backup.manifest.fingerprints);
    expect(await restored.db.prepare('PRAGMA foreign_key_check').all()).toMatchObject({
      results: [],
    });
    expect(restored.assertPublication).toThrow('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
    for (const table of [
      'agencies',
      'users',
      'agency_memberships',
      'auth_identities',
      'local_credentials',
      'local_sessions',
      'system_audit_events',
      'credential_operation_receipts',
    ]) {
      const sorted = (rows: unknown[]) => rows.map((r) => canonicalizePayload(r)).sort();
      expect(sorted((await restored.db.prepare(`SELECT * FROM ${table}`).all()).results)).toEqual(
        sorted((await source.db.prepare(`SELECT * FROM ${table}`).all()).results),
      );
    }
    expect(
      await restored.db
        .prepare(
          "SELECT must_change_password,temporary_expires_at,credential_version FROM local_credentials WHERE user_id='synthetic-temporary'",
        )
        .first(),
    ).toEqual({
      must_change_password: 1,
      temporary_expires_at: SYNTHETIC_AUTH_TIME + 86400000,
      credential_version: 7,
    });
    expect(
      await restored.db
        .prepare(
          "SELECT must_change_password,temporary_expires_at,credential_version FROM local_credentials WHERE user_id='synthetic-permanent'",
        )
        .first(),
    ).toEqual({ must_change_password: 0, temporary_expires_at: null, credential_version: 7 });
    // Explicit test composition only; no password generation, real KDF or raw tokens.
    const hasher: PasswordHasher = {
      supports: () => true,
      async hash() {
        throw new Error('KDF_FORBIDDEN');
      },
      async verify() {
        return { matches: false, needsRehash: false };
      },
    };
    const app = createApp({ passwordHasher: hasher });
    const response = await app.fetch(new Request('https://panel.mayisigorta.com/api/me'), {
      DB: restored.db,
      APP_ENV: 'test',
      PANEL_ORIGIN: 'https://panel.mayisigorta.com',
      CSRF_SECRET: 'synthetic-test-only-csrf-not-in-backup',
      DOCUMENTS_ENABLED: 'false',
    });
    expect(response.status).toBe(401);
    // Safe LOCAL measurements only; no exported rows or runtime configuration.
    writeFileSync(
      join(tmpdir(), 'mayi-local-auth-restore-timings.json'),
      JSON.stringify({
        classification: 'LOCAL/SYNTHETIC',
        productionRpoAccepted: false,
        productionRtoAccepted: false,
        exportElapsedMs: source.exportElapsedMs,
        restoreElapsedMs: restored.report.restoreElapsedMs,
        verificationElapsedMs: restored.report.verificationElapsedMs,
      }),
    );
  } finally {
    await restored.dispose();
  }
});

it('fresh target repeatability preserves identical fingerprints and never mutates source', async () => {
  const before = (await source.db.prepare('SELECT * FROM local_credentials').all()).results;
  const a = await restoreSyntheticAuthBackup(source.backup);
  try {
    const b = await restoreSyntheticAuthBackup(source.backup);
    try {
      expect(a.db === b.db).toBe(false);
      expect(a.report.fingerprints).toEqual(b.report.fingerprints);
      expect(a.report.schemaHash).toBe(b.report.schemaHash);
    } finally {
      await b.dispose();
    }
  } finally {
    await a.dispose();
  }
  expect((await source.db.prepare('SELECT * FROM local_credentials').all()).results).toEqual(
    before,
  );
});
it('manifest is canonical/deterministic and contains hashes only, not credential payloads', () => {
  const m = source.backup.manifest;
  expect(sha(canonicalizePayload(Object.fromEntries(Object.entries(m).reverse())))).toBe(
    source.backup.manifestSha256,
  );
  expect(m.history.map((r) => r.name.slice(0, 4))).toEqual(
    Array.from({ length: 21 }, (_, i) => String(i).padStart(4, '0')),
  );
  expect(JSON.stringify(m)).not.toContain('synthetic-verifier');
  expect(JSON.stringify(m)).not.toContain('a'.repeat(64));
  const a = JSON.parse(source.backup.artifactJson) as AuthBackupArtifact;
  expect(Object.keys(a.data.local_sessions![0]!)).not.toContain('token');
  expect(Object.keys(a.data.local_credentials![0]!)).not.toContain('password');
});
it('independent deterministic synthetic sources produce identical artifact and manifest', async () => {
  const other = await createSyntheticAuthBackup();
  try {
    expect(other.backup.artifactJson).toBe(source.backup.artifactJson);
    expect(other.backup.manifest).toEqual(source.backup.manifest);
    expect(other.backup.manifestSha256).toBe(source.backup.manifestSha256);
  } finally {
    await other.dispose();
  }
});
it('source/target identity confusion is rejected instead of accepting caller-supplied target', async () => {
  await expect(
    restoreSyntheticAuthBackup({
      ...source.backup,
      target: 'synthetic-local-auth-source',
    } as SyntheticAuthBackup),
  ).rejects.toThrow();
});
it('backup artifact hash mismatch fails closed', async () => {
  await expect(
    restoreSyntheticAuthBackup({
      ...source.backup,
      artifactJson: source.backup.artifactJson + ' ',
    }),
  ).rejects.toThrow('ARTIFACT_HASH_MISMATCH');
});
it('manifest hash mismatch fails closed', async () => {
  await expect(
    restoreSyntheticAuthBackup({ ...source.backup, manifestSha256: '0'.repeat(64) }),
  ).rejects.toThrow('MANIFEST_HASH_MISMATCH');
});
it.each(['schema hash', 'missing migration', 'reordered migration history'] as const)(
  '%s fails closed',
  async (kind) => {
    const b = manifestChange((b) => {
      if (kind === 'schema hash') b.manifest.schemaHash = '0'.repeat(64);
      else if (kind === 'missing migration') b.manifest.history.pop();
      else b.manifest.history.reverse();
    });
    await expect(restoreSyntheticAuthBackup(b)).rejects.toThrow();
  },
);
it.each(['missing table', 'changed trigger', 'changed index', 'missing view'] as const)(
  '%s fails closed even with updated artifact hash',
  async (kind) => {
    const b = artifactChange((a) => {
      const type =
        kind === 'missing table'
          ? 'table'
          : kind === 'changed trigger'
            ? 'trigger'
            : kind === 'changed index'
              ? 'index'
              : 'view';
      const i = a.schema.findIndex((r) => r.type === type && r.sql !== null);
      if (kind.startsWith('missing')) a.schema.splice(i, 1);
      else
        a.schema[i]!.sql =
          type === 'trigger'
            ? a.schema[i]!.sql!.replace(
                'BEGIN',
                "BEGIN SELECT RAISE(ABORT,'SYNTHETIC_CORRUPTION');",
              )
            : a.schema[i]!.sql + ' WHERE 0';
    });
    await expect(restoreSyntheticAuthBackup(b)).rejects.toThrow();
  },
);
it.each([
  'verifier',
  'credential_version',
  'must_change_password',
  'temporary_expires_at',
] as const)('corrupted %s fails closed', async (field) => {
  const b = artifactChange((a) => {
    const r = a.data.local_credentials!.find((r) => r.user_id === 'synthetic-temporary')!;
    r[field] =
      field === 'verifier'
        ? 'corrupted-verifier'
        : field === 'must_change_password'
          ? 0
          : Number(r[field]) + 1;
  });
  await expect(restoreSyntheticAuthBackup(b)).rejects.toThrow('DATA_FINGERPRINT_MISMATCH');
});
it.each(['auth_identities', 'agency_memberships', 'local_credentials', 'local_sessions'] as const)(
  'orphan %s fails closed even with recomputed unsigned fingerprints',
  async (table) => {
    const b = artifactChange((a) => {
      a.data[table]![0]!.user_id = 'synthetic-missing-user';
    }, true);
    await expect(restoreSyntheticAuthBackup(b)).rejects.toThrow('DB_FK_FAILED');
  },
);
it('missing audit row fails closed', async () => {
  await expect(
    restoreSyntheticAuthBackup(
      artifactChange((a) => {
        a.data.system_audit_events!.pop();
      }),
    ),
  ).rejects.toThrow('DATA_FINGERPRINT_MISMATCH');
});
it('duplicate protected auth row fails closed even with recomputed fingerprints', async () => {
  await expect(
    restoreSyntheticAuthBackup(
      artifactChange((a) => {
        a.data.local_credentials!.push({ ...a.data.local_credentials![0]! });
      }, true),
    ),
  ).rejects.toThrow();
});
it.each(['plaintext_password', 'raw_session_token'] as const)(
  '%s export field fails closed even with recomputed fingerprints',
  async (field) => {
    const b = artifactChange((a) => {
      a.data.local_credentials![0]![field] = 'synthetic-forbidden-marker';
    }, true);
    await expect(restoreSyntheticAuthBackup(b)).rejects.toThrow();
  },
);
it('foreign key corruption fails closed', async () => {
  await expect(
    restoreSyntheticAuthBackup(
      artifactChange((a) => {
        a.data.credential_operation_receipts![0]!.agency_id = 'synthetic-missing-agency';
      }, true),
    ),
  ).rejects.toThrow('DB_FK_FAILED');
});
it('missing session credential relation fails closed even when declared foreign keys are valid', async () => {
  const result = await restoreSyntheticAuthBackup(
    artifactChange((a) => {
      a.data.local_credentials = a.data.local_credentials!.filter(
        (r) => r.user_id !== 'synthetic-permanent',
      );
    }, true),
  ).then(
    async (r) => {
      await r.dispose();
      return { accepted: true, code: r.report.code };
    },
    (error: Error) => ({ accepted: false, code: error.message }),
  );
  expect(result).toEqual({ accepted: false, code: 'AUTH_RELATION_MISMATCH' });
});
it('publication before reconciliation is denied and fetch is not used by native proof', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  try {
    const r = await restoreSyntheticAuthBackup(source.backup);
    try {
      expect(r.assertPublication).toThrow('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
      expect(r.report.reconciliationRequired).toHaveLength(6);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await r.dispose();
    }
  } finally {
    fetch.mockRestore();
  }
});
async function rejectedRelation(backup: SyntheticAuthBackup) {
  return restoreSyntheticAuthBackup(backup).then(
    async (r) => {
      await r.dispose();
      return { accepted: true, code: r.report.code };
    },
    (error: Error) => ({ accepted: false, code: error.message }),
  );
}
it('receipt actor membership must resolve to the same actor user and agency', async () => {
  const result = await rejectedRelation(
    artifactChange((a) => {
      a.data.credential_operation_receipts![0]!.actor_membership_id =
        'synthetic-membership-permanent';
    }, true),
  );
  expect(result).toEqual({ accepted: false, code: 'AUTH_RELATION_MISMATCH' });
});
it.each(['NORMAL temporary', 'ACTIVATION permanent', 'ACTIVATION expiry'] as const)(
  'retrospective session state rejects %s',
  async (kind) => {
    const result = await rejectedRelation(
      artifactChange((a) => {
        if (kind === 'NORMAL temporary')
          a.data.local_sessions!.find((r) => r.kind === 'ACTIVATION')!.kind = 'NORMAL';
        else if (kind === 'ACTIVATION permanent') {
          const r = a.data.local_sessions!.find(
            (r) => r.kind === 'NORMAL' && r.revoked_at === null,
          )!;
          r.kind = 'ACTIVATION';
          r.recent_password_at = null;
          r.expires_at = Number(r.created_at) + 900000;
        } else
          a.data.local_credentials!.find(
            (r) => r.must_change_password === 1,
          )!.temporary_expires_at = SYNTHETIC_AUTH_TIME + 1;
      }, true),
    );
    expect(result).toEqual({ accepted: false, code: 'AUTH_RELATION_MISMATCH' });
  },
);
it('manifest carries deterministic app version, snapshot timestamp and synthetic bookmark', () => {
  expect(source.backup.manifest).toMatchObject({
    appVersion: '0.1.0',
    createdAt: '2026-09-01T00:00:00.000Z',
    bookmark: 'synthetic-paused-native-export',
  });
});
it.each(['appVersion', 'createdAt', 'bookmark'] as const)(
  'manifest %s is strictly bound and hashed',
  async (field) => {
    const b = manifestChange((b) => {
      (b.manifest as unknown as Record<string, unknown>)[field] = 'unsupported-synthetic-value';
    });
    await expect(restoreSyntheticAuthBackup(b)).rejects.toThrow();
  },
);
it('historical revoked session versions remain forensic state, not live authority', async () => {
  const b = artifactChange((a) => {
    const r = a.data.local_sessions!.find((r) => r.revoked_at !== null)!;
    r.credential_version = 6;
    r.permission_version = 2;
  }, true);
  const restored = await restoreSyntheticAuthBackup(b);
  try {
    expect(
      await restored.db
        .prepare(
          'SELECT credential_version,permission_version FROM local_sessions WHERE revoked_at IS NOT NULL',
        )
        .first(),
    ).toEqual({ credential_version: 6, permission_version: 2 });
    expect(restored.assertPublication).toThrow('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
  } finally {
    await restored.dispose();
  }
});
it('receipt actor membership cannot cross agency even when all referenced rows exist', async () => {
  const b = artifactChange((a) => {
    a.data.agencies!.push({
      ...a.data.agencies![0]!,
      id: 'synthetic-other-agency',
      status: 'PROVISIONING',
      bootstrap_completed_at: null,
      activated_at: null,
    });
    a.data.credential_operation_receipts![0]!.agency_id = 'synthetic-other-agency';
  }, true);
  expect(await rejectedRelation(b)).toEqual({ accepted: false, code: 'AUTH_RELATION_MISMATCH' });
});

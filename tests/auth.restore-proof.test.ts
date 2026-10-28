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
import { runRenewalGenerationForAgency } from '../src/server/renewals/generation';

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

it('restores current 0022 notes and pending generation, resumes exactly once and remains sealed', async () => {
  expect(source.backup.manifest.schemaVersion).toBe('0022');
  expect(source.backup.manifest.highestMigration).toBe('0022_renewal_generation_continuation.sql');
  expect(source.backup.manifest.history).toHaveLength(23);
  const restored = await restoreSyntheticAuthBackup(source.backup);
  try {
    for (const table of [
      'customer_notes',
      'operation_receipts',
      'audit_events',
      'renewal_generation_cursors',
    ])
      expect(
        (await restored.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results,
      ).toEqual((await source.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results);
    expect(
      await restored.db.prepare('SELECT content,author_name FROM customer_notes').first(),
    ).toEqual({
      content: 'Sentetik müşteri notu.\nİkinci satır: “alıntı”.',
      author_name: 'Sentetik İlk Ad',
    });
    expect(
      await restored.db
        .prepare("SELECT display_name FROM users WHERE id='synthetic-permanent'")
        .first(),
    ).toEqual({ display_name: 'Sonraki Ad' });
    const before = await restored.db.prepare('SELECT * FROM renewal_generation_cursors').first<{
      continuation_json: string;
      last_attempt_order: number;
      last_successful_local_date: string;
    }>();
    expect(before).toMatchObject({
      last_successful_local_date: '2026-08-31',
      last_attempt_order: 7,
    });
    expect(JSON.parse(before!.continuation_json)).toMatchObject({
      through: '2026-09-01',
      key: { policyId: 'synthetic-policy-03' },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T06:00:00.000Z'));
    try {
      expect(
        await runRenewalGenerationForAgency(restored.db, 'synthetic-auth-agency'),
      ).toMatchObject({ createdCount: 2, completedThrough: '2026-09-01' });
      expect(
        (await runRenewalGenerationForAgency(restored.db, 'synthetic-auth-agency')).createdCount,
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    for (const table of ['renewal_opportunities', 'tasks', 'renewal_state_history'])
      expect(await restored.db.prepare(`SELECT count(*) AS count FROM ${table}`).first()).toEqual({
        count: 6,
      });
    expect(
      await restored.db
        .prepare(
          "SELECT count(*) AS count FROM system_audit_events WHERE action='renewal.generate'",
        )
        .first(),
    ).toEqual({ count: 6 });
    expect(
      await restored.db
        .prepare(
          'SELECT last_successful_local_date,continuation_json,last_attempt_order FROM renewal_generation_cursors',
        )
        .first(),
    ).toEqual({
      last_successful_local_date: '2026-09-01',
      continuation_json: null,
      last_attempt_order: 7,
    });
    expect((await restored.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    await expect(
      restored.db.prepare("UPDATE customer_notes SET content='forged'").run(),
    ).rejects.toThrow('CUSTOMER_NOTE_IMMUTABLE');
    await expect(restored.db.prepare('DELETE FROM customer_notes').run()).rejects.toThrow(
      'CUSTOMER_NOTE_IMMUTABLE',
    );
    expect(restored.assertPublication).toThrow('SEALED_EXTERNAL_CONTROL_PLANE_PENDING');
  } finally {
    await restored.dispose();
  }
}, 120000);

it.each(['note author', 'continuation JSON'] as const)(
  'rejects inconsistent %s even after unsigned artifact fingerprints are recomputed',
  async (kind) => {
    const changed = artifactChange((artifact) => {
      if (kind === 'note author')
        artifact.data.customer_notes![0]!.author_user_id = 'synthetic-temporary';
      else artifact.data.renewal_generation_cursors![0]!.continuation_json = '{"offset":4}';
    }, true);
    expect(await rejectedRelation(changed)).toEqual({
      accepted: false,
      code: 'OPERATIONAL_RECOVERY_INVALID',
    });
  },
);

it.each([
  'note membership',
  'receipt payload',
  'receipt result',
  'note audit',
  'audit actor',
  'extra audit',
  'missing note',
  'completed date',
  'rotation',
  'window',
  'key',
  'generation history',
  'generation audit',
  'missing cursor',
] as const)(
  'rejects corrupted %s recovery evidence even with recomputed fingerprints',
  async (kind) => {
    const changed = artifactChange((a) => {
      const saved = a.data.renewal_generation_cursors![0]!;
      const receipt = a.data.operation_receipts!.find(
        (row) => row.action === 'customer.note.create',
      )!;
      if (kind === 'note membership')
        a.data.customer_notes![0]!.author_membership_id = 'synthetic-membership-temporary';
      if (kind === 'receipt payload') receipt.payload_fingerprint = '0'.repeat(64);
      if (kind === 'receipt result')
        receipt.response_body = JSON.stringify({ id: '22222222-2222-4222-8222-222222222222' });
      if (kind === 'note audit') a.data.audit_events = [];
      if (kind === 'audit actor') {
        a.data.audit_events![0]!.actor_user_id = 'synthetic-temporary';
        a.data.audit_events![0]!.actor_membership_id = 'synthetic-membership-temporary';
      }
      if (kind === 'extra audit')
        a.data.audit_events!.push({
          ...a.data.audit_events![0]!,
          id: 'synthetic-extra-note-audit',
          actor_user_id: 'synthetic-temporary',
          actor_membership_id: 'synthetic-membership-temporary',
        });
      if (kind === 'missing note') a.data.customer_notes = [];
      if (kind === 'completed date') saved.last_successful_local_date = '2026-08-30';
      if (kind === 'rotation') saved.last_attempt_order = -1;
      if (kind === 'window' || kind === 'key') {
        const pending = JSON.parse(String(saved.continuation_json));
        if (kind === 'window') pending.upperDate = '2026-10-02';
        else pending.key.endDate = '2026-12-01';
        saved.continuation_json = JSON.stringify(pending);
      }
      if (kind === 'generation history') a.data.renewal_state_history!.pop();
      if (kind === 'generation audit')
        a.data.system_audit_events = a.data.system_audit_events!.filter(
          (row) => row.id !== 'synthetic-generation-00',
        );
      if (kind === 'missing cursor') a.data.renewal_generation_cursors = [];
    }, true);
    expect(await rejectedRelation(changed)).toEqual({
      accepted: false,
      code: 'OPERATIONAL_RECOVERY_INVALID',
    });
  },
);
it.each(['content', 'author snapshot', 'checkpoint', 'rotation', 'completion date'] as const)(
  'detects %s changes against the original deterministic table fingerprint',
  async (kind) => {
    const changed = artifactChange((a) => {
      if (kind === 'content') a.data.customer_notes![0]!.content = 'Changed content';
      if (kind === 'author snapshot') a.data.customer_notes![0]!.author_name = 'Changed author';
      if (kind === 'checkpoint') a.data.renewal_generation_cursors![0]!.continuation_json = '{}';
      if (kind === 'rotation') a.data.renewal_generation_cursors![0]!.last_attempt_order = 8;
      if (kind === 'completion date')
        a.data.renewal_generation_cursors![0]!.last_successful_local_date = '2026-08-30';
    });
    await expect(restoreSyntheticAuthBackup(changed)).rejects.toThrow('DATA_FINGERPRINT_MISMATCH');
  },
);
it('rejects a note with a missing customer FK even after fingerprints are recomputed', async () => {
  await expect(
    restoreSyntheticAuthBackup(
      artifactChange((a) => {
        a.data.customer_notes![0]!.customer_id = 'synthetic-missing-customer';
      }, true),
    ),
  ).rejects.toThrow('DB_FK_FAILED');
});
it('does not relabel a 0020 manifest as a current recovery proof', async () => {
  const changed = manifestChange((backup) => {
    (backup.manifest as unknown as Record<string, unknown>).schemaVersion = '0020';
  });
  await expect(restoreSyntheticAuthBackup(changed)).rejects.toThrow();
});

it('restores populated synthetic F-27 auth into a fresh native D1 and stays sealed', async () => {
  const restored = await restoreSyntheticAuthBackup(source.backup);
  try {
    expect(restored.report.code).toBe('VERIFIED_SEALED');
    expect(restored.report.schemaHash).toBe(
      'f7d308266f6376551ba964e0df0089cf2f1a8eca466c9f54dadaf1c29ec4c763',
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
    Array.from({ length: 23 }, (_, i) => String(i).padStart(4, '0')),
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

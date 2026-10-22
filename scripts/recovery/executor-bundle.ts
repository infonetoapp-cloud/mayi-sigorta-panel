import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalizePayload } from '../../src/server/mutations/canonical';
import { orderedD1Import } from './ordered-d1-import';
import {
  authSchemaHash,
  AUTH_RESTORE_SCHEMA_HASH,
  type AuthBackupArtifact,
} from './local-auth-restore-proof';
import { verifyOperationalRecovery } from './operational-data-proof';
import { verifyHistoryChain, type RestoreHistoryEdge } from './renewal-history-proof';
import { createOps001Portfolio } from './synthetic-portfolio';

export const sha256 = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export const canonical = canonicalizePayload;
export function requireProof(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const files = ['native.sql', 'derived.sql', 'portfolio.json'] as const;
const fileEntry = z.strictObject({
  sha256: digest,
  bytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024),
});
const manifestSchema = z.strictObject({
  format: z.literal('OPS001_SYNTHETIC_BUNDLE_V1'),
  classification: z.literal('LOCAL_SYNTHETIC_ONLY'),
  producer: z.literal('builtin-ops001-portfolio'),
  schemaVersion: z.literal('0022'),
  migrationSources: z
    .array(
      z.strictObject({
        id: z.number().int().positive(),
        name: z.string().regex(/^\d{4}_.+\.sql$/),
        sourceSha256: digest,
      }),
    )
    .length(23),
  snapshotStartedAt: z.iso.datetime(),
  snapshotCompletedAt: z.iso.datetime(),
  files: z.strictObject({
    'native.sql': fileEntry,
    'derived.sql': fileEntry,
    'portfolio.json': fileEntry,
  }),
});
export type BundleManifest = z.infer<typeof manifestSchema>;
export interface RecoveryBundle {
  manifest: BundleManifest;
  manifestSha256: string;
  native: string;
  derived: string;
  artifact: AuthBackupArtifact;
}
export type Row = Record<string, unknown>;
export type RecoveryQuery = (sql: string) => readonly Row[] | Promise<readonly Row[]>;
const schemaSql =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB '_cf_*' AND name<>'sqlite_sequence' ORDER BY type,name";
const rowHash = (rows: readonly Row[]) =>
  sha256(
    JSON.stringify(
      rows
        .map((r) => JSON.parse(canonical(r)))
        .sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0)),
    ),
  );
function readBounded(directory: string, name: string, max: number) {
  const path = join(directory, name),
    stat = lstatSync(path);
  requireProof(stat.isFile() && !stat.isSymbolicLink() && stat.size <= max, 'BUNDLE_FILE_DENIED');
  return readFileSync(path, 'utf8');
}
export function readRecoveryBundle(
  directory: string,
  expectedManifestSha256: string,
): RecoveryBundle {
  digest.parse(expectedManifestSha256);
  const text = readBounded(directory, 'bundle-manifest.json', 65536);
  requireProof(sha256(text) === expectedManifestSha256, 'BUNDLE_MANIFEST_HASH_MISMATCH');
  const manifest = manifestSchema.parse(JSON.parse(text));
  const migrationSources = readdirSync('db/migrations')
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name, index) => ({
      id: index + 1,
      name,
      sourceSha256: sha256(readFileSync(join('db/migrations', name), 'utf8')),
    }));
  requireProof(
    canonical(manifest.migrationSources) === canonical(migrationSources),
    'MIGRATION_HISTORY_MISMATCH',
  );
  requireProof(
    Date.parse(manifest.snapshotStartedAt) <= Date.parse(manifest.snapshotCompletedAt) &&
      Date.parse(manifest.snapshotCompletedAt) <= Date.now(),
    'SNAPSHOT_TIME_INVALID',
  );
  const content = {} as Record<(typeof files)[number], string>;
  for (const name of files) {
    const text = readBounded(directory, name, 16 * 1024 * 1024);
    requireProof(
      Buffer.byteLength(text) === manifest.files[name].bytes &&
        sha256(text) === manifest.files[name].sha256,
      'BUNDLE_FILE_HASH_MISMATCH',
    );
    content[name] = text;
  }
  // This is decoder-produced transport, never arbitrary caller-selected SQL.
  requireProof(
    orderedD1Import(content['native.sql']) === content['derived.sql'],
    'DERIVED_SQL_MISMATCH',
  );
  const artifact = JSON.parse(content['portfolio.json']) as AuthBackupArtifact;
  requireProof(
    artifact.format === 'mayi-synthetic-auth-export-v1' &&
      artifact.sourceId === 'synthetic-local-auth-source',
    'SYNTHETIC_SOURCE_REQUIRED',
  );
  requireProof(
    artifact.data.customers?.length === 1 &&
      artifact.data.customers[0]?.id === 'synthetic-customer' &&
      artifact.data.customers[0]?.display_name === 'Synthetic',
    'SYNTHETIC_SOURCE_REQUIRED',
  );
  const ids = [
    'synthetic-temporary',
    'synthetic-permanent',
    'synthetic-offboard',
    'synthetic-revoked',
  ].sort();
  requireProof(
    canonical(artifact.data.users?.map((r) => r.id).sort()) === canonical(ids),
    'SYNTHETIC_SOURCE_REQUIRED',
  );
  requireProof(
    artifact.data.local_credentials?.every(
      (r) =>
        typeof r.login_email === 'string' &&
        r.login_email.endsWith('@example.invalid') &&
        typeof r.verifier === 'string' &&
        r.verifier.startsWith('synthetic-'),
    ),
    'SYNTHETIC_SOURCE_REQUIRED',
  );
  return {
    manifest,
    manifestSha256: expectedManifestSha256,
    native: content['native.sql'],
    derived: content['derived.sql'],
    artifact,
  };
}

export async function verifyRecoverySnapshot(query: RecoveryQuery, bundle: RecoveryBundle) {
  const schema = (await query(schemaSql)) as AuthBackupArtifact['schema'];
  requireProof(
    authSchemaHash(schema) === AUTH_RESTORE_SCHEMA_HASH &&
      authSchemaHash(bundle.artifact.schema) === AUTH_RESTORE_SCHEMA_HASH,
    'SCHEMA_MISMATCH',
  );
  const tables = schema
    .filter((r) => r.type === 'table')
    .map((r) => r.name)
    .sort();
  requireProof(
    tables.length === 46 &&
      canonical(tables) === canonical(Object.keys(bundle.artifact.data).sort()),
    'TABLE_SET_MISMATCH',
  );
  let total = 0;
  for (const table of tables) {
    requireProof(/^[a-z][a-z0-9_]*$/.test(table), 'TABLE_NAME_INVALID');
    const rows = await query(`SELECT * FROM "${table}"`),
      expected = bundle.artifact.data[table]!;
    requireProof(
      rows.length === expected.length && rowHash(rows) === rowHash(expected),
      'RESTORE_ROWS_MISMATCH',
    );
    total += rows.length;
  }
  requireProof(total === 114, 'ROW_TOTAL_MISMATCH');
  requireProof((await query('PRAGMA foreign_key_check')).length === 0, 'FOREIGN_KEY_INVALID');
  requireProof((await query('PRAGMA quick_check'))[0]?.quick_check === 'ok', 'CONSISTENCY_FAILED');
  const ledger = await query('SELECT id,name FROM d1_migrations ORDER BY id');
  requireProof(
    canonical(ledger) ===
      canonical(bundle.manifest.migrationSources.map(({ id, name }) => ({ id, name }))),
    'MIGRATION_HISTORY_MISMATCH',
  );
  const money = await query(
    'SELECT currency,SUM(gross_premium_minor) AS minor FROM policies GROUP BY currency ORDER BY currency',
  );
  requireProof(
    canonical(money) === canonical([{ currency: 'TRY', minor: 183456 }]),
    'MONETARY_INTEGRITY_FAILED',
  );
  requireProof(
    canonical(
      await query('SELECT gross_premium_minor FROM renewal_quote_versions ORDER BY version_number'),
    ) === canonical([{ gross_premium_minor: 12345 }, { gross_premium_minor: 23456 }]),
    'MONETARY_INTEGRITY_FAILED',
  );
  await verifyOperationalRecovery(query);
  for (const renewal of await query('SELECT id,state FROM renewal_opportunities')) {
    const history = await query(
      `SELECT id,from_state,to_state,actor_kind,reason_code,created_at FROM renewal_state_history WHERE renewal_id='${String(renewal.id).replaceAll("'", "''")}'`,
    );
    verifyHistoryChain(history as unknown as RestoreHistoryEdge[], String(renewal.state));
  }
  const evidence = await query(`SELECT count(*) AS n FROM renewal_quote_events e
    JOIN renewal_quotes q ON q.id=e.quote_id AND q.agency_id=e.agency_id
    JOIN operation_receipts r ON r.id=e.operation_receipt_id AND r.agency_id=e.agency_id
    JOIN audit_events a ON a.agency_id=r.agency_id AND a.actor_user_id=r.actor_user_id
      AND a.actor_membership_id=r.actor_membership_id AND a.idempotency_key=r.idempotency_key
      AND a.action='renewal.quote.sent' AND a.outcome='SUCCESS' AND a.target_type='renewal_opportunities' AND a.target_id=q.renewal_id
    WHERE e.event='SENT' AND r.action='renewal.quote.send' AND r.status='COMPLETED'`);
  requireProof(evidence[0]?.n === 1, 'RECEIPT_AUDIT_INCONSISTENT');
  return {
    tables: 46,
    rows: 114,
    migrations: 23,
    foreignKeyViolations: 0,
    schemaHash: AUTH_RESTORE_SCHEMA_HASH,
    policyMinor: 183456,
    level: 'SQL_ONLY' as const,
    apiAuthorization: 'NOT_EXECUTED' as const,
  };
}

const membership = z.strictObject({
  id: z.string().startsWith('synthetic-membership-'),
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  permission_version: z.number().int().positive(),
  version: z.number().int().positive(),
  suspended_at: z.string().nullable(),
});
const grant = z.strictObject({
  id: z.string(),
  membership_id: z.literal('synthetic-membership-permanent'),
  permission_code: z.literal('customer.read'),
  scope: z.literal('AGENCY'),
});
const authoritySchema = z.strictObject({
  format: z.literal('OPS001_CURRENT_AUTHORITY_V1'),
  classification: z.literal('INDEPENDENT_SYNTHETIC_CURRENT_STATE'),
  sourceSha256: digest,
  sequence: z.literal(1),
  issuedAt: z.iso.datetime(),
  memberships: z.array(membership).length(4),
  grants: z.array(grant).length(1),
  tombstones: z.array(z.never()).length(0),
  sensitiveGrants: z.literal('INVALIDATE_ALL'),
  sessions: z.literal('REVOKE_ALL'),
});
export type CurrentAuthority = z.infer<typeof authoritySchema>;
export function currentAuthorityFor(bundle: RecoveryBundle): CurrentAuthority {
  const memberships = bundle.artifact.data.agency_memberships!.map((r) => ({
    id: String(r.id),
    status: r.status as 'ACTIVE' | 'SUSPENDED',
    permission_version: Number(r.permission_version),
    version: Number(r.version),
    suspended_at: r.suspended_at as string | null,
  }));
  for (const r of memberships) {
    if (r.id === 'synthetic-membership-permanent' || r.id === 'synthetic-membership-offboard') {
      r.version++;
      r.permission_version++;
    }
    if (r.id === 'synthetic-membership-offboard') {
      r.status = 'SUSPENDED';
      r.suspended_at = new Date().toISOString();
    }
  }
  const retained = bundle.artifact.data.membership_permissions!.find(
    (r) => r.permission_code === 'customer.read',
  )!;
  return authoritySchema.parse({
    format: 'OPS001_CURRENT_AUTHORITY_V1',
    classification: 'INDEPENDENT_SYNTHETIC_CURRENT_STATE',
    sourceSha256: bundle.manifest.files['native.sql'].sha256,
    sequence: 1,
    issuedAt: new Date().toISOString(),
    memberships,
    grants: [
      {
        id: retained.id,
        membership_id: retained.membership_id,
        permission_code: retained.permission_code,
        scope: retained.scope,
      },
    ],
    tombstones: [],
    sensitiveGrants: 'INVALIDATE_ALL',
    sessions: 'REVOKE_ALL',
  });
}
export function readCurrentAuthority(
  path: string,
  expectedSha: string,
  bundle: RecoveryBundle,
): CurrentAuthority {
  digest.parse(expectedSha);
  const stat = lstatSync(path);
  requireProof(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536,
    'AUTHORITY_FILE_DENIED',
  );
  const text = readFileSync(path, 'utf8');
  requireProof(sha256(text) === expectedSha, 'AUTHORITY_HASH_MISMATCH');
  const ledger = authoritySchema.parse(JSON.parse(text));
  requireProof(
    ledger.sourceSha256 === bundle.manifest.files['native.sql'].sha256 &&
      Date.parse(ledger.issuedAt) >= Date.parse(bundle.manifest.snapshotCompletedAt) &&
      Date.parse(ledger.issuedAt) <= Date.now(),
    'CURRENT_AUTHORITY_REQUIRED',
  );
  const old = bundle.artifact.data.agency_memberships!;
  requireProof(
    new Set(ledger.memberships.map((r) => r.id)).size === 4,
    'CURRENT_AUTHORITY_REQUIRED',
  );
  for (const row of ledger.memberships) {
    const before = old.find((r) => r.id === row.id);
    requireProof(before, 'CURRENT_AUTHORITY_REQUIRED');
    const changed =
      row.id === 'synthetic-membership-permanent' || row.id === 'synthetic-membership-offboard';
    requireProof(
      row.version === Number(before.version) + (changed ? 1 : 0) &&
        row.permission_version === Number(before.permission_version) + (changed ? 1 : 0),
      'AUTHORITY_VERSION_INVALID',
    );
    requireProof(
      row.status === (row.id === 'synthetic-membership-offboard' ? 'SUSPENDED' : before.status),
      'CURRENT_AUTHORITY_REQUIRED',
    );
    requireProof(
      row.status !== 'SUSPENDED' ||
        (typeof row.suspended_at === 'string' && Number.isFinite(Date.parse(row.suspended_at))),
      'CURRENT_AUTHORITY_REQUIRED',
    );
  }
  return ledger;
}
export async function verifyCurrentAuthority(
  query: RecoveryQuery,
  authority: CurrentAuthority,
  bundle: RecoveryBundle,
) {
  const expected = [...authority.memberships].sort((a, b) => (a.id < b.id ? -1 : 1));
  const securityTables = new Set([
    'agency_memberships',
    'membership_permissions',
    'local_credentials',
    'local_sessions',
  ]);
  requireProof(
    authSchemaHash((await query(schemaSql)) as AuthBackupArtifact['schema']) ===
      AUTH_RESTORE_SCHEMA_HASH,
    'SCHEMA_MISMATCH',
  );
  for (const [table, rows] of Object.entries(bundle.artifact.data)) {
    if (securityTables.has(table)) continue;
    requireProof(/^[a-z][a-z0-9_]*$/.test(table), 'TABLE_NAME_INVALID');
    requireProof(
      rowHash(await query(`SELECT * FROM "${table}"`)) === rowHash(rows),
      'RESTORE_ROWS_MISMATCH',
    );
  }
  const fullMemberships = bundle.artifact.data.agency_memberships!.map((row) => ({
    ...row,
    ...authority.memberships.find((current) => current.id === row.id),
  }));
  requireProof(
    rowHash(await query('SELECT * FROM agency_memberships')) === rowHash(fullMemberships),
    'REVOCATION_RECONCILIATION_FAILED',
  );
  requireProof(
    canonical(
      await query(
        'SELECT id,status,permission_version,version,suspended_at FROM agency_memberships ORDER BY id',
      ),
    ) === canonical(expected),
    'REVOCATION_RECONCILIATION_FAILED',
  );
  requireProof(
    canonical(
      await query(
        'SELECT id,membership_id,permission_code,scope FROM membership_permissions ORDER BY id',
      ),
    ) === canonical([...authority.grants].sort((a, b) => (a.id < b.id ? -1 : 1))),
    'REVOCATION_RECONCILIATION_FAILED',
  );
  for (const table of ['users', 'auth_identities'])
    requireProof(
      rowHash(await query(`SELECT * FROM ${table}`)) === rowHash(bundle.artifact.data[table]!),
      'REVOCATION_RECONCILIATION_FAILED',
    );
  const sessions = await query('SELECT * FROM local_sessions');
  for (const before of bundle.artifact.data.local_sessions!)
    if (before.revoked_at !== null)
      requireProof(
        sessions.find((row) => row.token_hash === before.token_hash)?.revoked_at ===
          before.revoked_at,
        'SESSION_RECONCILIATION_FAILED',
      );
  const immutableSessions = (rows: readonly Row[]) =>
    rows.map(({ revoked_at: _revoked, ...row }) => row);
  requireProof(
    rowHash(immutableSessions(sessions)) ===
      rowHash(immutableSessions(bundle.artifact.data.local_sessions!)),
    'SESSION_RECONCILIATION_FAILED',
  );
  const credentials = bundle.artifact.data.local_credentials!.map((row) =>
    row.user_id === 'synthetic-offboard'
      ? { ...row, login_enabled: 0, credential_version: Number(row.credential_version) + 1 }
      : row,
  );
  requireProof(
    rowHash(await query('SELECT * FROM local_credentials')) === rowHash(credentials),
    'CREDENTIAL_RECONCILIATION_FAILED',
  );
  requireProof(
    (await query('SELECT count(*) AS n FROM local_sessions WHERE revoked_at IS NULL'))[0]?.n === 0,
    'SESSION_RECONCILIATION_FAILED',
  );
  requireProof(
    (
      await query(
        "SELECT count(*) AS n FROM local_credentials c JOIN agency_memberships m ON m.user_id=c.user_id WHERE m.status='SUSPENDED' AND c.login_enabled<>0",
      )
    )[0]?.n === 0,
    'CREDENTIAL_RECONCILIATION_FAILED',
  );
  requireProof(
    (await query('SELECT count(*) AS n FROM sensitive_action_grants'))[0]?.n === 0,
    'GRANT_RECONCILIATION_FAILED',
  );
  requireProof((await query('PRAGMA foreign_key_check')).length === 0, 'FOREIGN_KEY_INVALID');
  return {
    level: 'SQL_ONLY' as const,
    apiAuthorization: 'NOT_EXECUTED' as const,
    publication: 'SEALED' as const,
  };
}

export async function retainSyntheticBundle(directory: string) {
  const source = await createOps001Portfolio();
  try {
    const artifact = JSON.parse(source.backup.artifactJson) as AuthBackupArtifact;
    requireProof(
      Object.keys(artifact.data).length === 46 &&
        Object.values(artifact.data).reduce((a, r) => a + r.length, 0) === 114,
      'SYNTHETIC_FIXTURE_DRIFT',
    );
    const native = source.nativeExportSql,
      derived = orderedD1Import(native);
    mkdirSync(directory, { mode: 0o700 });
    const content = {
      'native.sql': native,
      'derived.sql': derived,
      'portfolio.json': JSON.stringify(artifact),
    };
    const manifest: BundleManifest = {
      format: 'OPS001_SYNTHETIC_BUNDLE_V1',
      classification: 'LOCAL_SYNTHETIC_ONLY',
      producer: 'builtin-ops001-portfolio',
      schemaVersion: '0022',
      migrationSources: source.backup.manifest.history,
      snapshotStartedAt: source.snapshotStartedAt,
      snapshotCompletedAt: source.snapshotCompletedAt,
      files: Object.fromEntries(
        files.map((name) => [
          name,
          { sha256: sha256(content[name]), bytes: Buffer.byteLength(content[name]) },
        ]),
      ) as BundleManifest['files'],
    };
    for (const name of files)
      writeFileSync(join(directory, name), content[name], { flag: 'wx', mode: 0o600 });
    const manifestText = canonical(manifest);
    writeFileSync(join(directory, 'bundle-manifest.json'), manifestText, {
      flag: 'wx',
      mode: 0o600,
    });
    const bundle = readRecoveryBundle(directory, sha256(manifestText));
    const db = new DatabaseSync(':memory:', {
      enableForeignKeyConstraints: false,
      allowExtension: false,
    });
    try {
      db.exec(derived);
      await verifyRecoverySnapshot((sql) => db.prepare(sql).all(), bundle);
    } finally {
      db.close();
    }
    const authority = currentAuthorityFor(bundle),
      authorityText = canonical(authority);
    writeFileSync(join(directory, 'current-authority.json'), authorityText, {
      flag: 'wx',
      mode: 0o600,
    });
    // Root pins are emitted independently of SQL payloads; generated rows never enter logs.
    return {
      manifestSha256: bundle.manifestSha256,
      sourceSha256: manifest.files['native.sql'].sha256,
      derivedSha256: manifest.files['derived.sql'].sha256,
      authoritySha256: sha256(authorityText),
    };
  } finally {
    await source.dispose();
  }
}
